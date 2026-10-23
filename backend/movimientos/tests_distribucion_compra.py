"""Compra local repartida a otras sucursales, como una importacion."""

from decimal import Decimal

from django.contrib.auth import get_user_model
from django.db.models import Sum
from rest_framework.test import APITestCase

from importaciones.models import ImportacionEnvio, ImportacionInconveniente
from inventario.models import Bodega, Division, Inventario, SubDivision, Sucursal
from inventario.por_ubicar import POR_UBICAR_NOMBRE
from productos.models import Producto
from tipos.models import EstadoMovimiento, EstadoProducto, SubTipoMovimiento, TipoDivision, TipoMovimiento

from .serializers import MovimientoInventarioSerializer

BASE = "/movimientos/movimiento_inventario"


class DistribucionCompraLocalTests(APITestCase):
    def setUp(self):
        User = get_user_model()
        self.admin = User.objects.create_superuser(username="admin-cl@test.com", email="admin-cl@test.com", password="x")
        self.client.force_authenticate(self.admin)
        tipo_division, _ = TipoDivision.objects.get_or_create(nombre="General")
        self.matriz = Sucursal.objects.create(nombre="Matriz", direccion="Principal")
        division = Division.objects.create(
            bodega=Bodega.objects.create(sucursal=self.matriz, nombre="Bodega"),
            tipo_division=tipo_division,
            nombre="Pasillo",
        )
        self.sub = SubDivision.objects.create(division=division, nombre="A")
        self.norte = Sucursal.objects.create(nombre="Norte", direccion="Av 1")
        Bodega.objects.create(sucursal=self.norte, nombre="Almacen")
        self.sur = Sucursal.objects.create(nombre="Sur", direccion="Av 2")
        Bodega.objects.create(sucursal=self.sur, nombre="Almacen")

        self.tipo_entrada, _ = TipoMovimiento.objects.get_or_create(nombre="Entrada")
        self.subtipo, _ = SubTipoMovimiento.objects.get_or_create(tipo_movimiento=self.tipo_entrada, nombre="Compra Local")
        self.recibido, _ = EstadoMovimiento.objects.get_or_create(nombre="Recibido")
        self.estado_producto, _ = EstadoProducto.objects.get_or_create(nombre="Disponible")
        self.producto = Producto.objects.create(codigo="CL-1", nombre="Filtro", precio=Decimal("10"))
        Inventario.objects.create(producto=self.producto, subdivision=self.sub, referencia="", cantidad=0)
        self.compra = self._crear_compra(10)
        self.url = f"{BASE}/{self.compra.id}/distribucion-compra/"

    def _payload(self, cantidad):
        return {
            "sucursal_id": self.matriz.id,
            "tipo_movimiento_id": self.tipo_entrada.id,
            "sub_tipo_movimiento_id": self.subtipo.id,
            "estado_movimiento_id": self.recibido.id,
            "no_documento": "CL-DIST",
            "factura_referencia": "FAC-1",
            "descripcion": "Compra",
            "fecha": "2026-10-23",
            "detalles": [{
                "producto_id": self.producto.id,
                "cantidad": cantidad,
                "estado_producto_id": self.estado_producto.id,
                "valor": "10.00",
                "valor_total": str(10 * cantidad),
                "costo": "6.00",
            }],
        }

    def _crear_compra(self, cantidad):
        serializer = MovimientoInventarioSerializer(data=self._payload(cantidad))
        self.assertTrue(serializer.is_valid(), serializer.errors)
        return serializer.save()

    def _stock(self, sucursal):
        return Inventario.objects.filter(
            producto=self.producto, subdivision__division__bodega__sucursal=sucursal
        ).aggregate(t=Sum("cantidad"))["t"] or 0

    def _repartir(self, *pares):
        return self.client.post(
            self.url,
            {
                "distribuciones": [
                    {"producto_id": self.producto.id, "sucursal_id": sucursal.id, "cantidad": cantidad}
                    for sucursal, cantidad in pares
                ],
                "destinatarios_por_sucursal": [{"sucursal_id": self.norte.id, "user_ids": [self.admin.id]}],
            },
            format="json",
        )

    def test_reparte_y_cada_sucursal_lo_recibe_como_envio(self):
        response = self._repartir((self.norte, 4), (self.sur, 2))
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["productos"][0]["enviado"], 6)
        # En la sucursal de la compra queda el resto; lo enviado esta en camino.
        self.assertEqual(self._stock(self.matriz), 4)
        self.assertEqual(self._stock(self.norte), 0)

        pendientes = self.client.get("/importaciones/importaciones/envios-pendientes/").data
        envio_norte = next(row for row in pendientes if row["sucursal_solicitante_id"] == self.norte.id)
        self.assertEqual(envio_norte["no_documento"], self.compra.no_documento)
        self.assertEqual(envio_norte["sucursal_proveedora"], "Compra local")
        self.assertEqual(envio_norte["detalles"][0]["cantidad_enviada"], 4)

        envio_url = f"/importaciones/importaciones/envios/{envio_norte['id']}"
        self.assertEqual(self.client.post(f"{envio_url}/confirmar-llegada/").status_code, 200)
        self.assertEqual(self._stock(self.norte), 4)
        self.assertEqual(
            Inventario.objects.get(producto=self.producto, subdivision__nombre=POR_UBICAR_NOMBRE).cantidad, 4
        )

        # Al contar solo aparecen 3: el faltante va a Inconvenientes, con la
        # sucursal de la compra como origen.
        nivel = SubDivision.objects.create(
            division=Division.objects.create(
                bodega=Bodega.objects.get(sucursal=self.norte),
                tipo_division=TipoDivision.objects.get(nombre="General"),
                nombre="B1",
            ),
            nombre="01",
        )
        self.client.post(
            f"{envio_url}/guardar-ubicaciones/",
            {"items": [{"producto_id": self.producto.id, "subdivision_id": nivel.id, "cantidad": 3}]},
            format="json",
        )
        response = self.client.post(f"{envio_url}/terminar-conteo/")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["faltantes"], 1)
        issue = ImportacionInconveniente.objects.get(envio_id=envio_norte["id"])
        self.assertIsNone(issue.importacion_id)
        self.assertEqual(issue.compra_local_id, self.compra.id)

        issues = self.client.get(
            f"/importaciones/importaciones/inconvenientes/?compra_local_id={self.compra.id}"
        ).data
        self.assertEqual(len(issues), 1)
        self.assertEqual(issues[0]["importacion_codigo"], self.compra.no_documento)
        self.assertEqual(issues[0]["sucursal_origen_id"], self.matriz.id)

        # "Nunca salieron": se suman en la sucursal de la compra, no en otra matriz.
        response = self.client.post(
            f"/importaciones/importaciones/inconvenientes/{issue.id}/resolver/",
            {"decision": "sumar_origen", "subdivision_id": self.sub.id},
            format="json",
        )
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(self._stock(self.matriz), 5)

    def test_no_se_reparte_mas_de_lo_comprado_ni_de_lo_que_hay(self):
        response = self._repartir((self.norte, 11))
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self._repartir((self.norte, 6)).status_code, 200)
        response = self._repartir((self.sur, 5))
        self.assertEqual(response.status_code, 400)
        self.assertIn("quedan 4", response.data["detail"])

        # Se vendieron 3 en la matriz: de las 4 que quedan por repartir solo hay 1.
        Inventario.objects.filter(subdivision=self.sub, producto=self.producto).update(cantidad=1)
        response = self._repartir((self.sur, 2))
        self.assertEqual(response.status_code, 400)
        self.assertIn("hay 1", response.data["detail"])
        self.assertEqual(ImportacionEnvio.objects.filter(compra_local=self.compra).count(), 1)

    def test_a_la_misma_sucursal_de_la_compra_no_se_envia(self):
        response = self._repartir((self.matriz, 3))
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self._stock(self.matriz), 10)

    def test_compra_repartida_no_cambia_cantidades_ni_se_elimina(self):
        self._repartir((self.norte, 4))
        payload = self._payload(12)
        payload["no_documento"] = self.compra.no_documento
        serializer = MovimientoInventarioSerializer(self.compra, data=payload)
        self.assertTrue(serializer.is_valid(), serializer.errors)
        with self.assertRaises(Exception):
            serializer.save()

        # Cambiar el costo si se puede.
        payload = self._payload(10)
        payload["no_documento"] = self.compra.no_documento
        payload["detalles"][0]["costo"] = "7.00"
        serializer = MovimientoInventarioSerializer(self.compra, data=payload)
        self.assertTrue(serializer.is_valid(), serializer.errors)
        serializer.save()
        self.assertEqual(self._stock(self.matriz), 6)

        response = self.client.delete(f"{BASE}/{self.compra.id}/")
        self.assertEqual(response.status_code, 400)

    def test_borrador_se_guarda_y_se_limpia_al_enviar(self):
        borrador = {"paso": 2, "reparto": {str(self.producto.id): {str(self.norte.id): "3"}}}
        response = self.client.patch(self.url, {"borrador": borrador}, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(self.client.get(self.url).data["borrador"], borrador)
        self._repartir((self.norte, 3))
        self.assertEqual(self.client.get(self.url).data["borrador"], {})

    def test_get_muestra_lo_comprado_y_lo_enviado(self):
        self._repartir((self.norte, 4))
        data = self.client.get(self.url).data
        self.assertEqual(data["sucursal_id"], self.matriz.id)
        self.assertEqual((data["productos"][0]["cantidad"], data["productos"][0]["enviado"]), (10, 4))
        self.assertEqual(data["envios"][0]["sucursal_id"], self.norte.id)

    def test_solo_la_matriz_reparte_sus_compras(self):
        from app.models import ReposicionConfiguracion

        self.assertTrue(MovimientoInventarioSerializer(self.compra).data["es_sucursal_matriz"])
        config = ReposicionConfiguracion.get_global()
        config.sucursal_central = self.norte
        config.save()

        self.assertFalse(MovimientoInventarioSerializer(self.compra).data["es_sucursal_matriz"])
        self.assertEqual(self.client.get(self.url).status_code, 400)
        response = self._repartir((self.sur, 2))
        self.assertEqual(response.status_code, 400, response.data)
        self.assertEqual(self._stock(self.matriz), 10)
