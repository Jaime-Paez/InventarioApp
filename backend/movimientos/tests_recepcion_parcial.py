"""Recepcion por partes con ubicacion temporal POR UBICAR y unidades en camino."""

from decimal import Decimal

from django.contrib.auth import get_user_model
from django.db.models import Sum
from rest_framework.test import APITestCase

from importaciones.models import Importacion, ImportacionEnvio, ImportacionEnvioDetalle
from inventario.models import Bodega, Division, Inventario, SubDivision, Sucursal
from inventario.por_ubicar import POR_UBICAR_NOMBRE, in_transit_by_product_branch
from productos.models import Producto
from tipos.models import EstadoMovimiento, EstadoProducto, SubTipoMovimiento, TipoDivision, TipoMovimiento

from .models import DetalleMovimiento, MovimientoInventario, SolicitudTraslado, SolicitudTrasladoDetalle

BASE = "/movimientos/movimiento_inventario/solicitudes-traslado"


class RecepcionParcialTrasladoTests(APITestCase):
    def setUp(self):
        User = get_user_model()
        self.admin = User.objects.create_superuser(
            username="admin-rp@test.com", email="admin-rp@test.com", password="x"
        )
        self.client.force_authenticate(self.admin)
        self.origen = Sucursal.objects.create(nombre="Origen", direccion="Dir 1")
        self.destino = Sucursal.objects.create(nombre="Destino", direccion="Dir 2")
        tipo, _ = TipoDivision.objects.get_or_create(nombre="General")
        almacen = Bodega.objects.create(sucursal=self.destino, nombre="Almacén Destino")
        percha = Division.objects.create(bodega=almacen, tipo_division=tipo, nombre="Percha 1")
        self.nivel = SubDivision.objects.create(division=percha, nombre="Nivel 1")
        self.p1 = Producto.objects.create(codigo="RP-1", nombre="Filtro", precio=Decimal("10"))
        self.p2 = Producto.objects.create(codigo="RP-2", nombre="Pastilla", precio=Decimal("5"))

        tipo_entrada, _ = TipoMovimiento.objects.get_or_create(nombre="Entrada")
        tipo_salida, _ = TipoMovimiento.objects.get_or_create(nombre="Salida")
        sub_salida, _ = SubTipoMovimiento.objects.get_or_create(tipo_movimiento=tipo_salida, nombre="Traslado")
        sub_entrada, _ = SubTipoMovimiento.objects.get_or_create(tipo_movimiento=tipo_entrada, nombre="Traslado")
        enviado, _ = EstadoMovimiento.objects.get_or_create(nombre="Enviado")
        EstadoMovimiento.objects.get_or_create(nombre="Recibido")
        EstadoMovimiento.objects.get_or_create(nombre="Parcialmente recibido")
        estado_producto, _ = EstadoProducto.objects.get_or_create(nombre="Nuevo")

        self.solicitud = SolicitudTraslado.objects.create(
            sucursal_solicitante=self.destino,
            sucursal_proveedora=self.origen,
            fecha="2026-10-06",
            no_documento="TR-RP-1",
            estado=SolicitudTraslado.Estados.APROBADA,
        )
        salida = MovimientoInventario.objects.create(
            sucursal=self.origen, sucursal_objetivo=self.destino, tipo_movimiento=tipo_salida,
            sub_tipo_movimiento=sub_salida, estado_movimiento=enviado, fecha="2026-10-06", no_documento="TR-RP-1",
        )
        entrada = MovimientoInventario.objects.create(
            sucursal=self.destino, sucursal_objetivo=self.origen, tipo_movimiento=tipo_entrada,
            sub_tipo_movimiento=sub_entrada, estado_movimiento=enviado, fecha="2026-10-06", no_documento="TR-RP-1",
        )
        for producto, cantidad in ((self.p1, 5), (self.p2, 3)):
            SolicitudTrasladoDetalle.objects.create(
                solicitud=self.solicitud, producto=producto, cantidad=cantidad, valor=Decimal("1")
            )
            DetalleMovimiento.objects.create(
                movimiento_inventario=entrada, producto=producto, cantidad=cantidad,
                estado_producto=estado_producto, valor=Decimal("1"), valor_total=Decimal(cantidad),
            )
        self.solicitud.movimiento_salida = salida
        self.solicitud.movimiento_entrada = entrada
        self.solicitud.save(update_fields=["movimiento_salida", "movimiento_entrada"])

    def _stock(self, producto, subdivision=None):
        qs = Inventario.objects.filter(producto=producto, subdivision__division__bodega__sucursal=self.destino)
        if subdivision is not None:
            qs = qs.filter(subdivision=subdivision)
        return qs.aggregate(total=Sum("cantidad"))["total"] or 0

    def _por_ubicar(self):
        return SubDivision.objects.get(
            division__bodega__sucursal=self.destino, division__nombre=POR_UBICAR_NOMBRE, nombre=POR_UBICAR_NOMBRE
        )

    def _en_camino(self, producto):
        return (in_transit_by_product_branch([producto.id]).get((producto.id, self.destino.id)) or {}).get("total", 0)

    def test_recibir_sin_ubicacion_va_a_por_ubicar_y_se_puede_vender(self):
        self.assertEqual(self._en_camino(self.p1), 5)
        response = self.client.post(
            f"{BASE}/{self.solicitud.id}/recibir-parcial/",
            {"items": [{"producto_id": self.p1.id, "cantidad": 5}]},
            format="json",
        )
        self.assertEqual(response.status_code, 200, response.data)
        por_ubicar = self._por_ubicar()
        # La division temporal se crea en el almacen de la sucursal.
        self.assertEqual(por_ubicar.division.bodega.nombre, "Almacén Destino")
        self.assertEqual(self._stock(self.p1, por_ubicar), 5)
        self.assertEqual(self._en_camino(self.p1), 0)
        self.assertEqual(self._en_camino(self.p2), 3)
        progreso = response.data["recepcion_progreso"][str(self.p1.id)]
        self.assertEqual((progreso["recibido"], progreso["pendiente_guardar"]), (5, 5))

    def test_recibir_con_ubicacion_va_directo(self):
        response = self.client.post(
            f"{BASE}/{self.solicitud.id}/recibir-parcial/",
            {"items": [{"producto_id": self.p1.id, "cantidad": 5, "subdivision_id": self.nivel.id}]},
            format="json",
        )
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(self._stock(self.p1, self.nivel), 5)
        self.assertEqual(response.data["recepcion_progreso"][str(self.p1.id)]["pendiente_guardar"], 0)

    def test_guardar_mueve_lo_que_queda_en_por_ubicar(self):
        self.client.post(
            f"{BASE}/{self.solicitud.id}/recibir-parcial/",
            {"items": [{"producto_id": self.p1.id, "cantidad": 5}]},
            format="json",
        )
        por_ubicar = self._por_ubicar()
        # Se venden 2 desde POR UBICAR antes de guardar.
        fila = Inventario.objects.get(producto=self.p1, subdivision=por_ubicar)
        fila.cantidad = 3
        fila.save(update_fields=["cantidad"])

        response = self.client.post(
            f"{BASE}/{self.solicitud.id}/guardar-ubicaciones/",
            {"items": [{"producto_id": self.p1.id, "subdivision_id": self.nivel.id}]},
            format="json",
        )
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(self._stock(self.p1, self.nivel), 3)
        self.assertEqual(self._stock(self.p1, por_ubicar), 0)
        self.assertEqual(response.data["recepcion_progreso"][str(self.p1.id)]["pendiente_guardar"], 0)

    def test_cerrar_no_duplica_stock_y_exige_guardar_antes(self):
        self.client.post(
            f"{BASE}/{self.solicitud.id}/recibir-parcial/",
            {"items": [{"producto_id": self.p1.id, "cantidad": 5}, {"producto_id": self.p2.id, "cantidad": 2}]},
            format="json",
        )
        body = {
            "resultado": "incompleto",
            "items": [
                {"producto_id": self.p1.id, "cantidad_recibida": 5, "ubicaciones": []},
                {"producto_id": self.p2.id, "cantidad_recibida": 2, "ubicaciones": [], "novedad": "Falto uno"},
            ],
        }
        bloqueado = self.client.post(f"{BASE}/{self.solicitud.id}/confirmar-recepcion/", body, format="json")
        self.assertEqual(bloqueado.status_code, 400)

        self.client.post(
            f"{BASE}/{self.solicitud.id}/guardar-ubicaciones/",
            {"items": [
                {"producto_id": self.p1.id, "subdivision_id": self.nivel.id},
                {"producto_id": self.p2.id, "subdivision_id": self.nivel.id},
            ]},
            format="json",
        )
        response = self.client.post(f"{BASE}/{self.solicitud.id}/confirmar-recepcion/", body, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(self._stock(self.p1), 5)
        self.assertEqual(self._stock(self.p2), 2)
        self.assertEqual(self._en_camino(self.p2), 0)

    def test_recibir_otro_producto_o_cantidad_invalida(self):
        otro = Producto.objects.create(codigo="RP-X", nombre="Otro", precio=Decimal("1"))
        response = self.client.post(
            f"{BASE}/{self.solicitud.id}/recibir-parcial/",
            {"items": [{"producto_id": otro.id, "cantidad": 1}]},
            format="json",
        )
        self.assertEqual(response.status_code, 400)
        response = self.client.post(
            f"{BASE}/{self.solicitud.id}/recibir-parcial/",
            {"items": [{"producto_id": self.p1.id, "cantidad": 0}]},
            format="json",
        )
        self.assertEqual(response.status_code, 400)


class RecepcionParcialImportacionTests(APITestCase):
    def setUp(self):
        from casa_comercial.models import CasaComercial

        User = get_user_model()
        self.admin = User.objects.create_superuser(
            username="admin-ri@test.com", email="admin-ri@test.com", password="x"
        )
        self.client.force_authenticate(self.admin)
        self.sucursal = Sucursal.objects.create(nombre="Norte", direccion="Av 1")
        Bodega.objects.create(sucursal=self.sucursal, nombre="Almacén Norte")
        casa = CasaComercial.objects.create(nombre="Casa", codigo="C1")
        importacion = Importacion.objects.create(codigo="IMP-RP-1", casa_comercial=casa)
        self.producto = Producto.objects.create(codigo="RI-1", nombre="Faro", precio=Decimal("10"))
        self.envio = ImportacionEnvio.objects.create(importacion=importacion, sucursal=self.sucursal)
        ImportacionEnvioDetalle.objects.create(envio=self.envio, producto=self.producto, cantidad=4)

    def test_recibir_por_partes_y_cerrar(self):
        transit = in_transit_by_product_branch([self.producto.id])[(self.producto.id, self.sucursal.id)]
        self.assertEqual(transit["total"], 4)
        self.assertEqual(transit["documentos"][0]["codigo"], "IMP-RP-1")

        url = f"/importaciones/importaciones/envios/{self.envio.id}"
        response = self.client.post(
            f"{url}/recibir-parcial/", {"items": [{"producto_id": self.producto.id, "cantidad": 4}]}, format="json"
        )
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(in_transit_by_product_branch([self.producto.id]), {})

        destino = SubDivision.objects.get(nombre=POR_UBICAR_NOMBRE, division__bodega__sucursal=self.sucursal)
        percha = Division.objects.create(
            bodega=destino.division.bodega, tipo_division=destino.division.tipo_division, nombre="B1"
        )
        nivel = SubDivision.objects.create(division=percha, nombre="01")
        self.client.post(
            f"{url}/guardar-ubicaciones/",
            {"items": [{"producto_id": self.producto.id, "subdivision_id": nivel.id}]},
            format="json",
        )
        response = self.client.post(
            f"{url}/confirmar-recepcion/",
            {"items": [{"producto_id": self.producto.id, "cantidad_recibida": 4, "ubicaciones": []}]},
            format="json",
        )
        self.assertEqual(response.status_code, 200, response.data)
        total = Inventario.objects.filter(producto=self.producto).aggregate(t=Sum("cantidad"))["t"]
        self.assertEqual(total, 4)
        self.envio.refresh_from_db()
        self.assertEqual(self.envio.estado, ImportacionEnvio.ESTADO_RECIBIDO)
