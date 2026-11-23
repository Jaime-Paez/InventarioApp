""""Importacion verificada" pone en el catalogo el precio final de cada
producto, tambien a los productos nuevos que se crean en ese momento (antes
los nuevos quedaban con el precio estimado de la sugerencia)."""

from datetime import date
from decimal import Decimal

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from casa_comercial.models import CasaComercial
from inventario.models import Sucursal
from productos.models import Producto
from tipos.models import EstadoMovimiento, EstadoProducto, SubTipoMovimiento, TipoMovimiento

from .models import Importacion, ImportacionDetalle


class PrecioFinalAlVerificarTests(APITestCase):
    def setUp(self):
        User = get_user_model()
        self.admin = User.objects.create_superuser(username="admin-pf@test.com", email="admin-pf@test.com", password="x")
        self.client.force_authenticate(self.admin)
        self.matriz = (
            Sucursal.objects.filter(nombre__icontains="matriz").order_by("id").first()
            or Sucursal.objects.create(nombre="9 de Octubre (Matriz)", direccion="Principal")
        )
        tipo_entrada, _ = TipoMovimiento.objects.get_or_create(nombre="Entrada")
        tipo_salida, _ = TipoMovimiento.objects.get_or_create(nombre="Salida")
        SubTipoMovimiento.objects.get_or_create(tipo_movimiento=tipo_entrada, nombre="Importación")
        SubTipoMovimiento.objects.get_or_create(tipo_movimiento=tipo_entrada, nombre="Traslado")
        SubTipoMovimiento.objects.get_or_create(tipo_movimiento=tipo_salida, nombre="Traslado")
        for nombre in ("Enviado", "Recibido", "Parcialmente recibido"):
            EstadoMovimiento.objects.get_or_create(nombre=nombre)
        EstadoProducto.objects.get_or_create(nombre="Disponible")

        casa = CasaComercial.objects.create(nombre="Casa PF", codigo="CPF")
        self.importacion = Importacion.objects.create(
            codigo="IMP-PF-1",
            casa_comercial=casa,
            estado=Importacion.ESTADO_EN_CAMINO,
            fecha_puerto=date(2026, 11, 1),
            fecha_llegada=date(2026, 11, 10),
        )
        self.existente = Producto.objects.create(codigo="PF-EXISTE", nombre="Faro", precio=Decimal("10"))
        self.det_existente = ImportacionDetalle.objects.create(
            importacion=self.importacion, producto=self.existente, codigo="PF-EXISTE", nombre="Faro",
            cantidad=4, precio_estimado=Decimal("6"), precio_confirmado=Decimal("7"), orden=1,
        )
        # Producto nuevo: todavia no existe en el catalogo; se crea al verificar.
        self.det_nuevo = ImportacionDetalle.objects.create(
            importacion=self.importacion, codigo="PF-NUEVO", nombre="Bomba", referencia="REF-PF",
            cantidad=5, precio_estimado=Decimal("5"), precio_confirmado=Decimal("6"), orden=2,
        )

    def test_precio_final_queda_en_el_catalogo_tambien_para_productos_nuevos(self):
        response = self.client.post(
            f"/importaciones/importaciones/{self.importacion.id}/marcar-llegada/",
            {
                "revisiones": [
                    {"detalle_id": self.det_existente.id, "cantidad_recibida": 4, "precio_final": "8.00", "comentario": "subio"},
                    {"detalle_id": self.det_nuevo.id, "cantidad_recibida": 5, "precio_final": "9.50", "comentario": "subio"},
                ],
                "distribuciones": [
                    {"detalle_id": self.det_existente.id, "sucursal_id": self.matriz.id, "cantidad": 4},
                    {"detalle_id": self.det_nuevo.id, "sucursal_id": self.matriz.id, "cantidad": 5},
                ],
            },
            format="json",
        )
        self.assertEqual(response.status_code, 200, getattr(response, "data", response))
        self.existente.refresh_from_db()
        nuevo = Producto.objects.get(codigo="PF-NUEVO")
        self.assertEqual(self.existente.precio, Decimal("8.00"))
        self.assertEqual(nuevo.precio, Decimal("9.50"))
        # Queda cuanto de cada fila (referencia) fue a cada sucursal.
        self.det_nuevo.refresh_from_db()
        self.assertEqual(self.det_nuevo.reparto_sucursales, {str(self.matriz.id): 5})
