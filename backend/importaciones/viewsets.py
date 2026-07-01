import statistics
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone

from rest_framework import filters, status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from usuarios.models import RolPermiso, UsuarioModuloSucursal
from usuarios.permissions import ImportacionesModulePermission
from usuarios.sucursal_scope import get_allowed_sucursal_ids, get_readable_sucursal_ids
from usuarios.utils import is_app_admin

from django.db.models import F

from app.models import ReminderState
from inventario.models import Inventario, SubDivision
from productos.models import Producto

from .models import Importacion, ImportacionDetalle, ImportacionEnvio, ImportacionEnvioDetalle
from .serializers import ImportacionDetalleSerializer, ImportacionSerializer, generate_next_importacion_code


class ImportacionViewSet(viewsets.ModelViewSet):
    serializer_class = ImportacionSerializer
    permission_classes = [IsAuthenticated, ImportacionesModulePermission]
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]

    def get_permissions(self):
        if self.action in ("envios_pendientes", "confirmar_recepcion_envio"):
            return [IsAuthenticated()]
        return super().get_permissions()

    def _check_specific_importacion_permission(self, request, flag_name):
        """Verifica un permiso específico de importaciones (puede_importar, puede_marcar_llegada)."""
        if is_app_admin(request.user):
            return True
        return UsuarioModuloSucursal.objects.filter(
            usuario=request.user,
            modulo=RolPermiso.Modulos.IMPORTACIONES,
            **{flag_name: True},
        ).exists()

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
    @action(detail=True, methods=["post"], url_path="pedir-cotizacion")
    def pedir_cotizacion(self, request, pk=None):
        if not self._check_specific_importacion_permission(request, "puede_importar"):
            return Response(
                {"detail": "No tienes permiso para ejecutar esta acción."},
                status=status.HTTP_403_FORBIDDEN,
            )
        instance = self.get_object()
        if instance.estado != Importacion.ESTADO_BORRADOR:
            return Response(
                {"detail": "Solo se puede pedir cotización desde estado borrador."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        instance.estado = Importacion.ESTADO_COTIZACION
        instance.save(update_fields=["estado"])
        serializer = self.get_serializer(instance)
        return Response(serializer.data)

    @transaction.atomic
    @action(detail=True, methods=["post"], url_path="confirmar")
    def confirmar(self, request, pk=None):
        if not self._check_specific_importacion_permission(request, "puede_importar"):
            return Response(
                {"detail": "No tienes permiso para ejecutar esta acción."},
                status=status.HTTP_403_FORBIDDEN,
            )
        instance = self.get_object()
        if instance.estado != Importacion.ESTADO_COTIZACION:
            return Response(
                {"detail": "Solo se puede confirmar desde estado cotización."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        instance.estado = Importacion.ESTADO_CONFIRMACION
        instance.save(update_fields=["estado"])
        serializer = self.get_serializer(instance)
        return Response(serializer.data)

    @transaction.atomic
    @action(detail=True, methods=["post"], url_path="importar")
    def importar(self, request, pk=None):
        if not self._check_specific_importacion_permission(request, "puede_importar"):
            return Response(
                {"detail": "No tienes permiso para ejecutar esta acción."},
                status=status.HTTP_403_FORBIDDEN,
            )
        instance = self.get_object()
        if instance.estado not in (Importacion.ESTADO_COTIZACION, Importacion.ESTADO_CONFIRMACION):
            return Response(
                {"detail": "Solo se puede importar desde estado cotización o confirmación."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        numero_factura = str(request.data.get("numero_factura") or "").strip()
        if not numero_factura:
            return Response(
                {"detail": "El número de factura es requerido."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Keys of selected items: String(producto_id) or "sc_{detalle_id}"
        selected_keys = set(str(k) for k in (request.data.get("detalles_seleccionados") or []))
        if not selected_keys:
            return Response(
                {"detail": "Selecciona al menos un producto para importar."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Build confirmed-price lookup from submitted detalles
        detalles_payload = request.data.get("detalles") or []
        confirmed_by_key = {}
        for d in detalles_payload:
            key = str(d["producto_id"]) if d.get("producto_id") else None
            if key:
                confirmed_by_key[key] = d

        today = timezone.localdate()

        # 1. Save confirmed data on all detalles of the original cotizacion and mark selection
        selected_detalles = []
        for detalle in instance.detalles.select_related("producto").all():
            key = str(detalle.producto_id) if detalle.producto_id else f"sc_{detalle.id}"
            confirmed = confirmed_by_key.get(key, {})
            precio_raw = confirmed.get("precio_confirmado")
            cant_raw = confirmed.get("cantidad_confirmada")
            if precio_raw not in (None, ""):
                try:
                    detalle.precio_confirmado = float(precio_raw)
                except (TypeError, ValueError):
                    pass
            if cant_raw not in (None, ""):
                try:
                    detalle.cantidad_confirmada = int(cant_raw)
                except (TypeError, ValueError):
                    pass
            detalle.seleccionado = key in selected_keys
            detalle.save(update_fields=["precio_confirmado", "cantidad_confirmada", "seleccionado"])
            if detalle.seleccionado:
                selected_detalles.append(detalle)

        # Transition the original cotizacion to importada (becomes the verification archive)
        instance.numero_factura = numero_factura
        instance.estado = Importacion.ESTADO_IMPORTADA
        instance.fecha_importacion = today
        instance.save(update_fields=["numero_factura", "estado", "fecha_importacion"])

        # 2. Create a new importacion in en_camino with only the selected items
        nueva = Importacion.objects.create(
            codigo=generate_next_importacion_code(instance.casa_comercial),
            estado=Importacion.ESTADO_EN_CAMINO,
            casa_comercial=instance.casa_comercial,
            fecha=today,
            numero_factura=numero_factura,
            fecha_importacion=today,
            dias_entrega_estimados=instance.dias_entrega_estimados,
            creado_por=request.user if request.user.is_authenticated else None,
        )
        ImportacionDetalle.objects.bulk_create([
            ImportacionDetalle(
                importacion=nueva,
                producto_id=d.producto_id,
                codigo=d.codigo,
                nombre=d.nombre,
                oem=d.oem,
                referencia=d.referencia,
                cantidad=d.cantidad_confirmada or d.cantidad,
                comentario=d.comentario,
                precio_confirmado=d.precio_confirmado,
                solicitud_id=d.solicitud_id,
                seleccionado=True,
            )
            for d in selected_detalles
        ])

        serializer = self.get_serializer(nueva)
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
        if not self._check_specific_importacion_permission(request, "puede_marcar_llegada"):
            return Response(
                {"detail": "No tienes permiso para ejecutar esta acción."},
                status=status.HTTP_403_FORBIDDEN,
            )
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

        # Group distributions by sucursal and create ImportacionEnvio records
        envios_by_sucursal = {}
        for dist in request.data.get("distribuciones", []):
            try:
                detalle_id = dist.get("detalle_id")
                sucursal_id = int(dist.get("sucursal_id") or 0)
                cantidad = int(dist.get("cantidad") or 0)
                if cantidad <= 0 or not detalle_id or not sucursal_id:
                    continue
                detalle = instance.detalles.select_related("producto").get(pk=detalle_id)
                if not detalle.producto_id:
                    continue
                envios_by_sucursal.setdefault(sucursal_id, []).append(
                    {"producto_id": detalle.producto_id, "cantidad": cantidad}
                )
            except Exception:
                continue

        for sucursal_id, items in envios_by_sucursal.items():
            envio = ImportacionEnvio.objects.create(
                importacion=instance,
                sucursal_id=sucursal_id,
            )
            ImportacionEnvioDetalle.objects.bulk_create([
                ImportacionEnvioDetalle(
                    envio=envio,
                    producto_id=item["producto_id"],
                    cantidad=item["cantidad"],
                )
                for item in items
            ])

        # Create reminders for selected recipients per sucursal
        for dest in request.data.get("destinatarios_por_sucursal", []):
            sucursal_id = dest.get("sucursal_id")
            user_ids = dest.get("user_ids", [])
            if user_ids and sucursal_id:
                self._create_importacion_reminder(instance, sucursal_id, user_ids, request.user)

        # Single reminder to all admins automatically
        User = get_user_model()
        admin_ids = [u.pk for u in User.objects.filter(is_active=True) if is_app_admin(u)]
        if admin_ids:
            self._create_importacion_reminder(instance, None, admin_ids, request.user)

        serializer = self.get_serializer(instance)
        return Response(serializer.data)

    def _create_importacion_reminder(self, importacion, sucursal_id, user_ids, actor_user):
        User = get_user_model()
        recipient_users = User.objects.filter(id__in=user_ids, is_active=True)
        recipients = [
            {"id": str(u.pk), "name": f"{u.first_name} {u.last_name}".strip() or u.username}
            for u in recipient_users
        ]
        if not recipients:
            return

        actor_name = f"{actor_user.first_name} {actor_user.last_name}".strip() or actor_user.username
        actor = {"id": str(actor_user.pk), "name": actor_name}
        now = timezone.localtime(timezone.now())
        created_at = timezone.now().isoformat()
        label = f"Importación {importacion.codigo}"
        description = (
            f"La {label} ha sido recibida y está siendo distribuida."
            if sucursal_id is None
            else f"Hay un envío en camino de {label} hacia tu sucursal."
        )

        reminder = {
            "id": str(uuid4()),
            "date": now.strftime("%Y-%m-%d"),
            "time": now.strftime("%H:%M"),
            "description": description,
            "creator": actor,
            "recipients": recipients,
            "context": {
                "type": "importacion",
                "id": str(importacion.pk),
                "label": label,
                "sucursal_destino_id": str(sucursal_id) if sucursal_id is not None else "",
            },
            "kind": "recordatorio_general",
            "createdAt": created_at,
            "decision": {"status": "enviado", "reason": "", "by": actor, "at": created_at, "assignedRecipients": []},
            "transferHistory": [{"stage": "enviado", "label": "Enviado", "description": description, "at": created_at, "actor": actor}],
            "completedBy": [],
        }

        with transaction.atomic():
            store = ReminderState.get_global(for_update=True)
            payload = store.payload if isinstance(store.payload, list) else []
            payload.insert(0, reminder)
            store.payload = payload
            store.save(update_fields=["payload", "updated_at"])

    @transaction.atomic
    @action(detail=False, methods=["post"], url_path="importar-directo")
    def importar_directo(self, request):
        if not self._check_specific_importacion_permission(request, "puede_importar"):
            return Response(
                {"detail": "No tienes permiso para ejecutar esta acción."},
                status=status.HTTP_403_FORBIDDEN,
            )

        from casa_comercial.models import CasaComercial

        casa_comercial_id = request.data.get("casa_comercial_id")
        dias_reales_raw = request.data.get("dias_reales_entrega")
        detalles_data = request.data.get("detalles", [])

        if not casa_comercial_id:
            return Response({"detail": "La casa comercial es requerida."}, status=status.HTTP_400_BAD_REQUEST)
        if not detalles_data:
            return Response({"detail": "Agrega al menos un producto."}, status=status.HTTP_400_BAD_REQUEST)

        try:
            casa = CasaComercial.objects.get(pk=casa_comercial_id)
        except CasaComercial.DoesNotExist:
            return Response({"detail": "Casa comercial no encontrada."}, status=status.HTTP_404_NOT_FOUND)

        try:
            dias_reales = int(dias_reales_raw) if dias_reales_raw not in (None, "", ) else None
        except (ValueError, TypeError):
            dias_reales = None

        today = timezone.localdate()
        importacion = Importacion.objects.create(
            codigo=generate_next_importacion_code(casa),
            estado=Importacion.ESTADO_IMPORTADA,
            casa_comercial=casa,
            fecha=today,
            fecha_importacion=today,
            dias_reales_entrega=dias_reales,
            dias_entrega_estimados=getattr(casa, "dias_entrega", None),
            creado_por=request.user if request.user.is_authenticated else None,
        )

        ImportacionDetalle.objects.bulk_create([
            ImportacionDetalle(
                importacion=importacion,
                producto_id=item.get("producto_id") or None,
                codigo=str(item.get("codigo") or ""),
                nombre=str(item.get("nombre") or ""),
                oem=str(item.get("oem") or ""),
                referencia=str(item.get("referencia") or ""),
                cantidad=int(item.get("cantidad") or 1),
            )
            for item in detalles_data
            if int(item.get("cantidad") or 0) > 0
        ])

        # Build envios grouped by sucursal (only matched products)
        envios_by_sucursal = {}
        for item in detalles_data:
            producto_id = item.get("producto_id")
            if not producto_id:
                continue
            for suc_id_str, qty in (item.get("sucursal_quantities") or {}).items():
                try:
                    suc_id = int(suc_id_str)
                    qty = int(qty)
                except (ValueError, TypeError):
                    continue
                if qty > 0:
                    envios_by_sucursal.setdefault(suc_id, []).append(
                        {"producto_id": producto_id, "cantidad": qty}
                    )

        for sucursal_id, items in envios_by_sucursal.items():
            envio = ImportacionEnvio.objects.create(
                importacion=importacion,
                sucursal_id=sucursal_id,
            )
            ImportacionEnvioDetalle.objects.bulk_create([
                ImportacionEnvioDetalle(
                    envio=envio,
                    producto_id=item["producto_id"],
                    cantidad=item["cantidad"],
                )
                for item in items
            ])

        # Update smart average for casa_comercial.dias_entrega
        if dias_reales is not None:
            ultimos = list(
                Importacion.objects.filter(
                    casa_comercial=casa,
                    dias_reales_entrega__isnull=False,
                )
                .order_by("-id")
                .values_list("dias_reales_entrega", flat=True)[:5]
            )
            nuevo_promedio = self._smart_average(ultimos)
            if nuevo_promedio is not None and nuevo_promedio > 0:
                casa.dias_entrega = nuevo_promedio
                casa.save(update_fields=["dias_entrega"])

        serializer = self.get_serializer(importacion)
        return Response(serializer.data, status=status.HTTP_201_CREATED)

    @action(detail=False, methods=["post"], url_path="parse-excel")
    def parse_excel(self, request):
        import openpyxl
        file = request.FILES.get("file")
        if not file:
            return Response({"detail": "No se envió ningún archivo."}, status=status.HTTP_400_BAD_REQUEST)
        try:
            wb = openpyxl.load_workbook(file, read_only=True, data_only=True)
            ws = wb.active
        except Exception:
            return Response({"detail": "No se pudo leer el archivo. Asegúrate de que sea un .xlsx válido."}, status=status.HTTP_400_BAD_REQUEST)

        all_rows = list(ws.iter_rows(values_only=True))
        if not all_rows:
            return Response({"detail": "El archivo está vacío."}, status=status.HTTP_400_BAD_REQUEST)

        header = [str(h or "").strip().upper() for h in all_rows[0]]
        sucursal_col_names = header[6:] if len(header) > 6 else []

        from inventario.models import Sucursal as SucursalModel
        suc_by_name = {s.nombre.strip().upper(): s.id for s in SucursalModel.objects.all()}
        sucursal_col_ids = [suc_by_name.get(name) for name in sucursal_col_names]

        def safe_str(val):
            return str(val or "").strip()

        def safe_int(val):
            try:
                return int(float(val))
            except (TypeError, ValueError):
                return 0

        def safe_float(val):
            try:
                return float(val or 0)
            except (TypeError, ValueError):
                return 0.0

        # Optional: validate products against a specific casa comercial
        try:
            casa_comercial_id = int(request.data.get("casa_comercial_id") or 0) or None
        except (ValueError, TypeError):
            casa_comercial_id = None

        parsed = []
        for row in all_rows[1:]:
            if all(cell is None or str(cell).strip() == "" for cell in (row[:6] if len(row) >= 6 else row)):
                continue
            codigo = safe_str(row[0]) if len(row) > 0 else ""
            referencia = safe_str(row[1]) if len(row) > 1 else ""
            oem = safe_str(row[2]) if len(row) > 2 else ""
            descripcion = safe_str(row[3]) if len(row) > 3 else ""
            cantidad = safe_int(row[4]) if len(row) > 4 else 0
            pvp = safe_float(row[5]) if len(row) > 5 else 0.0
            if not codigo and not descripcion:
                continue
            if cantidad <= 0:
                continue

            matched = None
            conflicto_casa = False
            conflicto_casa_nombre = ""
            if codigo:
                matched = Producto.objects.filter(codigo__iexact=codigo).first()

            if matched and casa_comercial_id:
                casas_ids = list(matched.casas_comerciales.values_list("id", flat=True))
                if casas_ids and casa_comercial_id not in casas_ids:
                    # Product is linked to other casa(s) but not the selected one
                    otra = matched.casas_comerciales.exclude(id=casa_comercial_id).first()
                    conflicto_casa = True
                    conflicto_casa_nombre = otra.nombre if otra else "otra casa comercial"
                    matched = None  # treat as unmatched so it never enters the import

            suc_quantities = {}
            for col_offset, suc_id in enumerate(sucursal_col_ids):
                col_idx = 6 + col_offset
                if suc_id is None or col_idx >= len(row):
                    continue
                qty = safe_int(row[col_idx])
                if qty > 0:
                    suc_quantities[str(suc_id)] = qty

            parsed.append({
                "codigo": codigo,
                "referencia": referencia,
                "oem": oem,
                "descripcion": descripcion,
                "cantidad": cantidad,
                "pvp": round(pvp, 2),
                "matched_producto_id": matched.id if matched else None,
                "matched_producto_codigo": matched.codigo if matched else None,
                "matched_producto_nombre": matched.nombre if matched else None,
                "sucursal_quantities": suc_quantities,
                "conflicto_casa": conflicto_casa,
                "conflicto_casa_nombre": conflicto_casa_nombre,
            })

        if not parsed:
            return Response({"detail": "No se encontraron filas con datos válidos (cantidad > 0)."}, status=status.HTTP_400_BAD_REQUEST)

        return Response({"rows": parsed, "total": len(parsed)}, status=status.HTTP_200_OK)

    @action(detail=False, methods=["get"], url_path="envios-pendientes")
    def envios_pendientes(self, request):
        if is_app_admin(request.user):
            qs = ImportacionEnvio.objects.filter(estado=ImportacionEnvio.ESTADO_PENDIENTE)
        else:
            allowed_ids = get_readable_sucursal_ids(
                request.user, RolPermiso.Modulos.MOVIMIENTOS_ENTRADAS
            )
            if allowed_ids is None:
                qs = ImportacionEnvio.objects.filter(estado=ImportacionEnvio.ESTADO_PENDIENTE)
            elif not allowed_ids:
                qs = ImportacionEnvio.objects.none()
            else:
                qs = ImportacionEnvio.objects.filter(
                    estado=ImportacionEnvio.ESTADO_PENDIENTE,
                    sucursal_id__in=allowed_ids,
                )

        qs = qs.select_related("importacion", "sucursal").prefetch_related(
            "detalles__producto"
        ).order_by("-fecha", "-id")

        payload = []
        for envio in qs:
            detalles_payload = [
                {
                    "detalle_id": int(d.id),
                    "producto_id": int(d.producto_id),
                    "producto_codigo": str(getattr(d.producto, "codigo", "") or "").strip(),
                    "producto_nombre": str(getattr(d.producto, "nombre", "") or "").strip(),
                    "cantidad_enviada": int(d.cantidad or 0),
                    "valor": 0,
                }
                for d in envio.detalles.all()
            ]
            payload.append({
                "id": int(envio.id),
                "envio_id": int(envio.id),
                "no_documento": str(envio.importacion.codigo or "").strip(),
                "fecha": envio.fecha,
                "sucursal_solicitante_id": int(envio.sucursal_id),
                "sucursal_solicitante": str(getattr(envio.sucursal, "nombre", "") or "").strip(),
                "sucursal_proveedora_id": None,
                "sucursal_proveedora": "Importación",
                "movimiento_salida_id": None,
                "movimiento_entrada_id": None,
                "estado_entrada": "Pendiente",
                "descripcion": f"Envío de Importación {envio.importacion.codigo}",
                "detalles": detalles_payload,
                "inconvenientes_pendientes": 0,
                "_source": "importacion",
            })

        return Response(payload, status=status.HTTP_200_OK)

    @transaction.atomic
    @action(detail=False, methods=["post"], url_path=r"envios/(?P<envio_id>\d+)/confirmar-recepcion")
    def confirmar_recepcion_envio(self, request, envio_id=None):
        try:
            envio = (
                ImportacionEnvio.objects.select_related("importacion", "sucursal")
                .prefetch_related("detalles__producto")
                .get(pk=envio_id, estado=ImportacionEnvio.ESTADO_PENDIENTE)
            )
        except ImportacionEnvio.DoesNotExist:
            return Response(
                {"detail": "Envío no encontrado o ya recibido."},
                status=status.HTTP_404_NOT_FOUND,
            )

        items = request.data.get("items")
        if not isinstance(items, list) or not items:
            return Response(
                {"detail": "Debes enviar la lista de productos en `items`."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        detalles_by_producto = {int(d.producto_id): d for d in envio.detalles.all()}
        seen_product_ids = set()
        for raw_item in items:
            try:
                product_id = int(raw_item.get("producto_id"))
            except (TypeError, ValueError):
                return Response(
                    {"detail": "Cada item debe tener producto_id válido."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if product_id in seen_product_ids:
                return Response(
                    {"detail": "No puedes repetir el mismo producto."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            seen_product_ids.add(product_id)
            if product_id not in detalles_by_producto:
                return Response(
                    {"detail": f"El producto {product_id} no pertenece a este envío."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        with transaction.atomic():
            envio_locked = ImportacionEnvio.objects.select_for_update().get(pk=envio.pk)
            if envio_locked.estado != ImportacionEnvio.ESTADO_PENDIENTE:
                return Response(
                    {"detail": "El envío ya fue recibido."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

            for raw_item in items:
                product_id = int(raw_item.get("producto_id"))
                cantidad_recibida = int(raw_item.get("cantidad_recibida") or 0)
                ubicaciones_raw = raw_item.get("ubicaciones") or []

                if isinstance(ubicaciones_raw, list) and ubicaciones_raw:
                    for ub in ubicaciones_raw:
                        subdivision_id = int(ub.get("subdivision_id") or 0)
                        qty = int(ub.get("cantidad") or 0)
                        if subdivision_id and qty > 0:
                            inv, _ = Inventario.objects.get_or_create(
                                producto_id=product_id,
                                subdivision_id=subdivision_id,
                                referencia="",
                                defaults={"cantidad": 0},
                            )
                            Inventario.objects.filter(pk=inv.pk).update(cantidad=F("cantidad") + qty)
                elif cantidad_recibida > 0:
                    subdivision = SubDivision.objects.filter(
                        division__bodega__sucursal_id=envio.sucursal_id
                    ).first()
                    if subdivision:
                        inv, _ = Inventario.objects.get_or_create(
                            producto_id=product_id,
                            subdivision=subdivision,
                            referencia="",
                            defaults={"cantidad": 0},
                        )
                        Inventario.objects.filter(pk=inv.pk).update(
                            cantidad=F("cantidad") + cantidad_recibida
                        )

            envio_locked.estado = ImportacionEnvio.ESTADO_RECIBIDO
            envio_locked.fecha_recepcion = timezone.localdate()
            envio_locked.recibido_por = request.user
            envio_locked.save(update_fields=["estado", "fecha_recepcion", "recibido_por"])

            # Update product prices from precio_confirmado on the importacion detalles
            precio_by_producto = {
                d.producto_id: d.precio_confirmado
                for d in envio_locked.importacion.detalles.filter(precio_confirmado__isnull=False)
                if d.producto_id
            }
            for product_id, nuevo_precio in precio_by_producto.items():
                Producto.objects.filter(pk=product_id).update(precio=nuevo_precio)

        User = get_user_model()
        admin_ids = [u.pk for u in User.objects.filter(is_active=True) if is_app_admin(u)]
        if admin_ids:
            self._create_importacion_reminder(envio.importacion, None, admin_ids, request.user)

        return Response(
            {"detail": "Recepción registrada correctamente.", "recordatorio_enviado": bool(admin_ids)},
            status=status.HTTP_200_OK,
        )

    def perform_destroy(self, instance):
        if instance.estado not in (Importacion.ESTADO_BORRADOR, Importacion.ESTADO_COTIZACION, Importacion.ESTADO_CONFIRMACION):
            from rest_framework.exceptions import ValidationError
            raise ValidationError("Solo se pueden eliminar importaciones en estado borrador, cotización o confirmación.")
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
