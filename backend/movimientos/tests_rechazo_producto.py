from decimal import Decimal

from django.contrib.auth import get_user_model
from django.urls import reverse
from rest_framework.test import APITestCase

from app.models import InspeccionAleatoriaItem, UsuarioPreferencia
from inventario.models import Bodega, Division, Inventario, SubDivision, Sucursal
from productos.models import Producto
from tipos.models import TipoDivision
from usuarios.models import RolPermiso, UsuarioModuloSucursal

from .models import SolicitudTraslado


class RechazoPorProductoTrasladoTests(APITestCase):
    """Al decidir un traslado cada producto se separa o se rechaza con un
    motivo: "No tengo" (con el conteo de quien rechaza, que queda como
    revision de inventario), "Ya lo vendi" u "Otro" (nota libre)."""

    def setUp(self):
        user_model = get_user_model()
        self.actor = user_model.objects.create_user(
            username="actor_rechazo",
            email="actor_rechazo@example.com",
            password="test12345",
        )
        UsuarioPreferencia.objects.get_or_create(usuario=self.actor, defaults={"es_administrador": True})
        self.client.force_authenticate(user=self.actor)

        self.solicitante = Sucursal.objects.create(nombre="Solicitante", direccion="Dir 1")
        self.proveedora = Sucursal.objects.create(nombre="Proveedora", direccion="Dir 2")
        bodeguero = user_model.objects.create_user(
            username="bodeguero_rechazo", email="bodeguero_rechazo@example.com", password="test12345"
        )
        UsuarioModuloSucursal.objects.create(
            usuario=bodeguero, modulo=RolPermiso.Modulos.MOVIMIENTOS_SALIDAS, sucursal=self.proveedora
        )
        tipo_division, _ = TipoDivision.objects.get_or_create(nombre="General")
        self.sub_a = self._subdivision(self.proveedora, tipo_division, "A")
        self.sub_b = self._subdivision(self.proveedora, tipo_division, "B")
        self.sub_otra_sucursal = self._subdivision(self.solicitante, tipo_division, "X")

        self.producto_1 = Producto.objects.create(codigo="RCH-1", nombre="Uno", precio=Decimal("10.00"))
        self.producto_2 = Producto.objects.create(codigo="RCH-2", nombre="Dos", precio=Decimal("10.00"))
        Inventario.objects.create(producto=self.producto_1, subdivision=self.sub_a, referencia="", cantidad=10)
        Inventario.objects.create(producto=self.producto_2, subdivision=self.sub_a, referencia="", cantidad=10)

        self.base_url = reverse("movimientos-movimiento-inventario-solicitudes-traslado")
        response = self.client.post(
            self.base_url,
            {
                "sucursal_solicitante_id": self.solicitante.id,
                "sucursal_proveedora_id": self.proveedora.id,
                "fecha": "2026-10-27",
                "descripcion": "Prueba rechazo",
                "recordatorio_destinatario_ids": [bodeguero.id],
                "detalles": [
                    {"producto_id": self.producto_1.id, "cantidad": 2, "valor": "10.00"},
                    {"producto_id": self.producto_2.id, "cantidad": 4, "valor": "10.00"},
                ],
            },
            format="json",
        )
        self.assertEqual(response.status_code, 201, response.data)
        self.solicitud = SolicitudTraslado.objects.get(pk=response.data["id"])
        self.detalle_1 = self.solicitud.detalles.get(producto=self.producto_1)
        self.detalle_2 = self.solicitud.detalles.get(producto=self.producto_2)

    def _subdivision(self, sucursal, tipo_division, suffix):
        bodega = Bodega.objects.create(sucursal=sucursal, nombre=f"Bodega {suffix}")
        division = Division.objects.create(bodega=bodega, tipo_division=tipo_division, nombre=f"Division {suffix}")
        return SubDivision.objects.create(division=division, nombre=f"Sub {suffix}")

    def _marcar(self, detalle, payload):
        return self.client.patch(
            f"{self.base_url}{self.solicitud.id}/detalles/{detalle.id}/verificar/",
            payload,
            format="json",
        )

    def _decidir(self):
        return self.client.post(
            f"{self.base_url}{self.solicitud.id}/decision/", {"decision": "aceptar"}, format="json"
        )

    def test_no_tengo_acepta_parcial_y_registra_el_conteo_de_quien_rechaza(self):
        self.assertEqual(self._marcar(self.detalle_1, {"estado": "separado"}).status_code, 200)
        response = self._marcar(
            self.detalle_2,
            {
                "estado": "no_enviar",
                "motivo_tipo": "no_tengo",
                "conteo": [
                    {"subdivision_id": self.sub_a.id, "cantidad": 1},
                    {"subdivision_id": self.sub_b.id, "cantidad": 2},
                ],
            },
        )
        self.assertEqual(response.status_code, 200, response.data)
        self.assertTrue(response.data["motivo_no_envio"].startswith("No tengo: hay 3"))

        response = self._decidir()
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["decision"], "aceptada")
        self.solicitud.refresh_from_db()
        self.assertEqual(self.solicitud.estado, SolicitudTraslado.Estados.APROBADA)
        self.assertEqual(list(self.solicitud.detalles.values_list("producto_id", flat=True)), [self.producto_1.id])
        self.assertEqual(self.solicitud.detalles_no_enviados[0]["motivo_tipo"], "no_tengo")

        item = InspeccionAleatoriaItem.objects.get(producto=self.producto_2)
        self.assertEqual(item.inspeccion.usuario_id, self.actor.id)
        self.assertEqual(item.sucursal_id, self.proveedora.id)
        self.assertEqual(item.cantidad_reportada, 3)
        self.assertEqual(item.cantidad_esperada, 10)
        self.assertEqual(item.verificacion_estado, InspeccionAleatoriaItem.EstadosVerificacion.PENDIENTE)
        conteo = {entry["subdivision_id"]: entry for entry in item.conteo_ubicaciones}
        self.assertEqual(conteo[self.sub_a.id]["cantidad_contada"], 1)
        self.assertEqual(conteo[self.sub_a.id]["cantidad_sistema"], 10)
        self.assertEqual(conteo[self.sub_b.id]["cantidad_contada"], 2)
        # El inventario no cambia hasta que administracion verifique.
        self.assertEqual(Inventario.objects.get(producto=self.producto_2, subdivision=self.sub_a).cantidad, 10)

    def test_todos_rechazados_rechaza_la_solicitud_con_el_motivo_de_cada_uno(self):
        self.assertEqual(
            self._marcar(self.detalle_1, {"estado": "no_enviar", "motivo_tipo": "vendido"}).status_code, 200
        )
        self.assertEqual(
            self._marcar(
                self.detalle_2, {"estado": "no_enviar", "motivo_tipo": "otro", "motivo": "Esta dañado"}
            ).status_code,
            200,
        )
        response = self._decidir()
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["decision"], "rechazada")
        self.solicitud.refresh_from_db()
        self.assertEqual(self.solicitud.estado, SolicitudTraslado.Estados.CANCELADA)
        self.assertIn("RCH-1 x2 (Ya lo vendí (por facturar))", self.solicitud.motivo_rechazo)
        self.assertIn("RCH-2 x4 (Esta dañado)", self.solicitud.motivo_rechazo)
        self.assertFalse(InspeccionAleatoriaItem.objects.exists())

    def test_crear_la_salida_no_rechaza_el_propio_traslado_por_cambio_de_stock(self):
        """Con el stock justo (lo pedido = lo que hay), descontarlo al crear
        la salida no debe "rechazar" el mismo traslado por cambio de stock."""
        from tipos.models import EstadoMovimiento, SubTipoMovimiento, TipoMovimiento

        Inventario.objects.filter(producto=self.producto_1).update(cantidad=2)
        Inventario.objects.filter(producto=self.producto_2).update(cantidad=4)
        for detalle in (self.detalle_1, self.detalle_2):
            self.assertEqual(self._marcar(detalle, {"estado": "separado"}).status_code, 200)
        self.assertEqual(self._decidir().status_code, 200)

        tipo_salida, _ = TipoMovimiento.objects.get_or_create(nombre="Salida")
        subtipo_traslado, _ = SubTipoMovimiento.objects.get_or_create(tipo_movimiento=tipo_salida, nombre="Traslado")
        estado_enviado, _ = EstadoMovimiento.objects.get_or_create(nombre="Enviado")
        response = self.client.post(
            reverse("movimientos-movimiento-inventario-list"),
            {
                "sucursal_id": self.proveedora.id,
                "sucursal_objetivo_id": self.solicitante.id,
                "tipo_movimiento_id": tipo_salida.id,
                "sub_tipo_movimiento_id": subtipo_traslado.id,
                "estado_movimiento_id": estado_enviado.id,
                "solicitud_traslado_id": self.solicitud.id,
                "tipo_envio": "envio_provincia",
                "descripcion": "Salida del traslado",
                "fecha": "2026-10-27",
                "detalles": [
                    {"producto_id": self.producto_1.id, "cantidad": 2, "valor": "10.00"},
                    {"producto_id": self.producto_2.id, "cantidad": 4, "valor": "10.00"},
                ],
            },
            format="json",
        )
        self.assertEqual(response.status_code, 201, response.data)
        self.solicitud.refresh_from_db()
        self.assertEqual(self.solicitud.estado, SolicitudTraslado.Estados.APROBADA)
        self.assertEqual(self.solicitud.motivo_rechazo, "")
        self.assertIsNone(self.solicitud.rechazada_en)
        self.assertIsNotNone(self.solicitud.movimiento_salida_id)

    def test_validaciones_del_rechazo(self):
        self.assertEqual(self._marcar(self.detalle_1, {"estado": "no_enviar"}).status_code, 400)
        self.assertEqual(
            self._marcar(self.detalle_1, {"estado": "no_enviar", "motivo_tipo": "otro"}).status_code, 400
        )
        response = self._marcar(
            self.detalle_1,
            {
                "estado": "no_enviar",
                "motivo_tipo": "no_tengo",
                "conteo": [{"subdivision_id": self.sub_otra_sucursal.id, "cantidad": 1}],
            },
        )
        self.assertEqual(response.status_code, 400)

    def test_ubicaciones_para_contar_no_muestran_cantidades(self):
        response = self.client.get(
            f"{self.base_url}{self.solicitud.id}/detalles/{self.detalle_2.id}/ubicaciones/?conteo=1"
        )
        self.assertEqual(response.status_code, 200, response.data)
        self.assertNotIn("total", response.data)
        self.assertEqual([u["subdivision_id"] for u in response.data["ubicaciones"]], [self.sub_a.id])
        self.assertNotIn("cantidad", response.data["ubicaciones"][0])
        self.assertEqual(
            {u["subdivision_id"] for u in response.data["ubicaciones_sucursal"]}, {self.sub_a.id, self.sub_b.id}
        )
        opcion = next(u for u in response.data["ubicaciones_sucursal"] if u["subdivision_id"] == self.sub_a.id)
        self.assertEqual(opcion["division_id"], self.sub_a.division_id)
        self.assertEqual(opcion["bodega_id"], self.sub_a.division.bodega_id)
