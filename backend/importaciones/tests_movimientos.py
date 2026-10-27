"""Una importacion repartida entra a la matriz y sale a cada sucursal como traslado."""

from decimal import Decimal

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from casa_comercial.models import CasaComercial
from inventario.models import Bodega, Division, SubDivision, Sucursal
from movimientos.models import MovimientoInventario
from productos.models import Producto
from tipos.models import EstadoMovimiento, EstadoProducto, SubTipoMovimiento, TipoDivision, TipoMovimiento

from .importacion_movimientos import crear_movimientos_importacion
from .models import Importacion, ImportacionDetalle, ImportacionEnvio, ImportacionEnvioDetalle


class MovimientosImportacionTests(APITestCase):
    def setUp(self):
        User = get_user_model()
        self.admin = User.objects.create_superuser(username="admin-mi@test.com", email="admin-mi@test.com", password="x")
        self.client.force_authenticate(self.admin)
        self.matriz = (
            Sucursal.objects.filter(nombre__icontains="matriz").order_by("id").first()
            or Sucursal.objects.create(nombre="9 de Octubre (Matriz)", direccion="Principal")
        )
        self.norte = Sucursal.objects.create(nombre="Norte MI", direccion="Av 1")
        tipo_division, _ = TipoDivision.objects.get_or_create(nombre="General")
        self.nivel = SubDivision.objects.create(
            division=Division.objects.create(
                bodega=Bodega.objects.create(sucursal=self.norte, nombre="Almacen"),
                tipo_division=tipo_division,
                nombre="B1",
            ),
            nombre="01",
        )
        tipo_entrada, _ = TipoMovimiento.objects.get_or_create(nombre="Entrada")
        tipo_salida, _ = TipoMovimiento.objects.get_or_create(nombre="Salida")
        SubTipoMovimiento.objects.get_or_create(tipo_movimiento=tipo_entrada, nombre="Importación")
        SubTipoMovimiento.objects.get_or_create(tipo_movimiento=tipo_entrada, nombre="Traslado")
        SubTipoMovimiento.objects.get_or_create(tipo_movimiento=tipo_salida, nombre="Traslado")
        for nombre in ("Enviado", "Recibido", "Parcialmente recibido"):
            EstadoMovimiento.objects.get_or_create(nombre=nombre)
        EstadoProducto.objects.get_or_create(nombre="Disponible")

        casa = CasaComercial.objects.create(nombre="Casa MI", codigo="CMI")
        self.importacion = Importacion.objects.create(codigo="IMP-MI-1", casa_comercial=casa)
        self.producto = Producto.objects.create(codigo="MI-1", nombre="Faro", precio=Decimal("10"))
        ImportacionDetalle.objects.create(
            importacion=self.importacion, producto=self.producto, cantidad=10, precio_confirmado=Decimal("7")
        )
        self.envios = []
        for sucursal, cantidad in ((self.matriz, 6), (self.norte, 4)):
            envio = ImportacionEnvio.objects.create(importacion=self.importacion, sucursal=sucursal)
            ImportacionEnvioDetalle.objects.create(envio=envio, producto=self.producto, cantidad=cantidad)
            self.envios.append(envio)

    def test_entra_a_la_matriz_y_sale_como_traslado(self):
        crear_movimientos_importacion(self.importacion, self.envios, actor=self.admin)

        entrada = self.importacion.movimiento_entrada
        self.assertEqual(entrada.sucursal_id, self.matriz.id)
        self.assertIn("Import", entrada.sub_tipo_movimiento.nombre)
        self.assertEqual(entrada.no_documento, "IMP-MI-1")
        self.assertEqual([(d.cantidad, d.valor) for d in entrada.detalles.all()], [(10, Decimal("7.00"))])

        envio_matriz, envio_norte = (ImportacionEnvio.objects.get(pk=e.pk) for e in self.envios)
        self.assertIsNone(envio_matriz.movimiento_salida_id)
        salida, entrada_norte = envio_norte.movimiento_salida, envio_norte.movimiento_entrada
        self.assertEqual((salida.sucursal_id, salida.sucursal_objetivo_id), (self.matriz.id, self.norte.id))
        self.assertEqual((entrada_norte.sucursal_id, entrada_norte.sucursal_objetivo_id), (self.norte.id, self.matriz.id))
        for movimiento in (salida, entrada_norte):
            self.assertEqual(movimiento.sub_tipo_movimiento.nombre, "Traslado")
            self.assertEqual(movimiento.estado_movimiento.nombre, "Enviado")
            self.assertEqual(movimiento.detalles.get().cantidad, 4)

        # No se editan ni se eliminan a mano.
        base = "/movimientos/movimiento_inventario"
        self.assertEqual(self.client.patch(f"{base}/{salida.id}/", {"descripcion": "x"}, format="json").status_code, 400)
        self.assertEqual(self.client.delete(f"{base}/{entrada.id}/").status_code, 400)

        # Llegan 3 de 4 a Norte: la entrada queda con 3 y ambas parcialmente recibidas.
        response = self.client.post(
            f"/importaciones/importaciones/envios/{envio_norte.id}/confirmar-recepcion/",
            {
                "items": [
                    {
                        "producto_id": self.producto.id,
                        "cantidad_recibida": 3,
                        "ubicaciones": [{"subdivision_id": self.nivel.id, "cantidad": 3}],
                    }
                ]
            },
            format="json",
        )
        self.assertEqual(response.status_code, 200, response.data)
        salida = MovimientoInventario.objects.get(pk=salida.pk)
        entrada_norte = MovimientoInventario.objects.get(pk=entrada_norte.pk)
        self.assertEqual(salida.estado_movimiento.nombre, "Parcialmente recibido")
        self.assertEqual(entrada_norte.estado_movimiento.nombre, "Parcialmente recibido")
        self.assertEqual(entrada_norte.detalles.get().cantidad, 3)
        self.assertEqual(salida.detalles.get().cantidad, 4)
