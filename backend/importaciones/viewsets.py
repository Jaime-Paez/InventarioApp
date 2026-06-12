import statistics

from django.db import transaction
from django.utils import timezone

from rest_framework import filters, status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from usuarios.permissions import SolicitudesModulePermission

from django.db.models import F

from inventario.models import Inventario, SubDivision
from productos.models import Producto

from .models import Importacion, ImportacionDetalle
from .serializers import ImportacionDetalleSerializer, ImportacionSerializer, generate_next_importacion_code


class ImportacionViewSet(viewsets.ModelViewSet):
    serializer_class = ImportacionSerializer
    permission_classes = [IsAuthenticated, SolicitudesModulePermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = [
        "codigo",
        "casa_comercial__nombre",
        "detalles__producto__codigo",
        "detalles__producto__nombre",
    ]
    ordering_fields = ["codigo", "fecha", "creado_en", "casa_comercial__nombre"]

    def get_queryset(self):
        queryset = (
            Importacion.objects.select_related("casa_comercial")
            .prefetch_related(
                "detalles",
                "detalles__producto",
                "detalles__producto__casas_comerciales",
                "detalles__producto__oem_productos__oem",
            )
            .all()
            .distinct()
        )
        estado = str(self.request.query_params.get("estado") or "").strip()
        if estado:
            queryset = queryset.filter(estado=estado)
        casa_comercial_id = str(self.request.query_params.get("casa_comercial_id") or "").strip()
        if casa_comercial_id:
            queryset = queryset.filter(casa_comercial_id=casa_comercial_id)
        return queryset

    @transaction.atomic
    @action(detail=True, methods=["post"], url_path="importar")
    def importar(self, request, pk=None):
        instance = self.get_object()
        if instance.estado != Importacion.ESTADO_BORRADOR:
            return Response(
                {"detail": "Solo se puede importar desde estado borrador."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        numero_factura = str(request.data.get("numero_factura") or "").strip()
        if not numero_factura:
            return Response(
                {"detail": "El número de factura es requerido."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        instance.numero_factura = numero_factura
        instance.estado = Importacion.ESTADO_EN_CAMINO
        instance.fecha_importacion = timezone.localdate()
        instance.save()
        serializer = self.get_serializer(instance)
        return Response(serializer.data)

    @staticmethod
    def _smart_average(tiempos):
        """
        Weighted average that discards outliers using Modified Z-score (MAD method).
        With values like [1, 41, 42, 42, 43] it excludes the lone 1 and returns ~42.
        """
        if not tiempos:
            return None
        if len(tiempos) <= 2:
            return round(sum(tiempos) / len(tiempos))

        med = statistics.median(tiempos)
        deviations = [abs(x - med) for x in tiempos]
        mad = statistics.median(deviations)

        if mad == 0:
            return round(med)

        scale = 1.4826 * mad
        filtered = [x for x, d in zip(tiempos, deviations) if (d / scale) <= 3.5]

        if not filtered:
            filtered = tiempos

        return round(sum(filtered) / len(filtered))

    @transaction.atomic
    @action(detail=True, methods=["post"], url_path="marcar-llegada")
    def marcar_llegada(self, request, pk=None):
        instance = self.get_object()
        if instance.estado != Importacion.ESTADO_EN_CAMINO:
            return Response(
                {"detail": "Solo se puede marcar llegada desde estado en camino."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        today = timezone.localdate()
        start = instance.fecha_importacion or instance.fecha
        dias_reales = (today - start).days if start else None

        instance.estado = Importacion.ESTADO_IMPORTADA
        instance.dias_reales_entrega = dias_reales
        instance.save()

        # Recalculate casa_comercial.dias_entrega from last 5 real delivery times
        if dias_reales is not None:
            ultimos = list(
                Importacion.objects.filter(
                    casa_comercial=instance.casa_comercial,
                    dias_reales_entrega__isnull=False,
                )
                .order_by("-id")
                .values_list("dias_reales_entrega", flat=True)[:5]
            )
            nuevo_promedio = self._smart_average(ultimos)
            if nuevo_promedio is not None and nuevo_promedio > 0:
                instance.casa_comercial.dias_entrega = nuevo_promedio
                instance.casa_comercial.save(update_fields=["dias_entrega"])

        # Distribute to sucursales
        for dist in request.data.get("distribuciones", []):
            try:
                detalle_id = dist.get("detalle_id")
                sucursal_id = dist.get("sucursal_id")
                cantidad = int(dist.get("cantidad") or 0)
                if cantidad <= 0 or not detalle_id or not sucursal_id:
                    continue
                detalle = instance.detalles.select_related("producto").get(pk=detalle_id)
                if not detalle.producto_id:
                    continue
                subdivision = SubDivision.objects.filter(
                    division__bodega__sucursal_id=sucursal_id
                ).first()
                if not subdivision:
                    continue
                inv, _ = Inventario.objects.get_or_create(
                    producto_id=detalle.producto_id,
                    subdivision=subdivision,
                    referencia="",
                    defaults={"cantidad": 0},
                )
                Inventario.objects.filter(pk=inv.pk).update(cantidad=F("cantidad") + cantidad)
            except Exception:
                continue

        serializer = self.get_serializer(instance)
        return Response(serializer.data)

    def perform_destroy(self, instance):
        if instance.estado != Importacion.ESTADO_BORRADOR:
            from rest_framework.exceptions import ValidationError
            raise ValidationError("Solo se pueden eliminar importaciones en estado borrador.")
        instance.delete()

    @transaction.atomic
    @action(detail=True, methods=["patch"], url_path=r"detalles/(?P<detalle_id>\d+)")
    def patch_detalle(self, request, pk=None, detalle_id=None):
        instance = self.get_object()
        try:
            detalle = instance.detalles.get(pk=detalle_id)
        except ImportacionDetalle.DoesNotExist:
            return Response({"detail": "Detalle no encontrado."}, status=status.HTTP_404_NOT_FOUND)
        producto_id = request.data.get("producto_id")
        if producto_id is not None:
            try:
                producto = Producto.objects.get(pk=producto_id)
            except Producto.DoesNotExist:
                return Response({"detail": "Producto no encontrado."}, status=status.HTTP_404_NOT_FOUND)
            detalle.producto = producto
            detalle.save(update_fields=["producto"])
        serializer = ImportacionDetalleSerializer(detalle)
        return Response(serializer.data)

    @action(detail=False, methods=["get"], url_path="next-code")
    def next_code(self, request):
        from casa_comercial.models import CasaComercial
        casa_id = request.query_params.get("casa_id")
        casa = None
        if casa_id:
            try:
                casa = CasaComercial.objects.get(pk=casa_id)
            except CasaComercial.DoesNotExist:
                pass
        return Response({"codigo": generate_next_importacion_code(casa)}, status=status.HTTP_200_OK)
