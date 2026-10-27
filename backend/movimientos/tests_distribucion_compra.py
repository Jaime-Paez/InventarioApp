"""Compra local repartida a otras sucursales: cada envio es un traslado."""

from decimal import Decimal

from django.contrib.auth import get_user_model
from django.db.models import Sum
from rest_framework.test import APITestCase

from inventario.models import Bodega, Division, Inventario, SubDivision, Sucursal
from productos.models import Producto
from tipos.models import EstadoMovimiento, EstadoProducto, SubTipoMovimiento, TipoDivision, TipoMovimiento

from .models import SolicitudTraslado, TrasladoInconveniente
from .serializers import MovimientoInventarioSerializer

BASE = "/movimientos/movimiento_inventario"


class DistribucionCompraLocalTests(APITestCase):
    def setUp(self):
        User = get_user_model()
        self.admin = User.objects.create_superuser(username="admin-cl@test.com", email="admin-cl@test.com", password="x")
        self.client.force_authenticate(self.admin)
        tipo_division, _ = TipoDivision.objects.get_or_create(nombre="General")
        self.matriz = Sucursal.objects.create(nombre="Matriz", direccion="Principal", puede_compra_local=True)
        # Solo la matriz (sucursal central de Reposicion) reparte sus compras;
        # las migraciones ya crean "9 de Octubre (Matriz)", por eso se fija aqui.
        from app.models import ReposicionConfiguracion

        config = ReposicionConfiguracion.get_global()
        config.sucursal_central = self.matriz
        config.save()
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
        EstadoMovimiento.objects.get_or_create(nombre="Enviado")
        EstadoMovimiento.objects.get_or_create(nombre="Parcialmente recibido")
        tipo_salida, _ = TipoMovimiento.objects.get_or_create(nombre="Salida")
        SubTipoMovimiento.objects.get_or_create(tipo_movimiento=tipo_salida, nombre="Traslado")
        SubTipoMovimiento.objects.get_or_create(tipo_movimiento=self.tipo_entrada, nombre="Traslado")
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
                "documentos_por_sucursal": [
                    {"sucursal_id": sucursal.id, "no_documento": f"ENV-{sucursal.id}"} for sucursal, _ in pares
                ],
            },
            format="json",
        )

    def test_sin_no_documento_no_se_envia(self):
        response = self.client.post(
            self.url,
            {
                "distribuciones": [{"producto_id": self.producto.id, "sucursal_id": self.norte.id, "cantidad": 2}],
                "documentos_por_sucursal": [{"sucursal_id": self.norte.id, "no_documento": "  "}],
            },
            format="json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("No. Documento", response.data["detail"])
        self.assertEqual(self._stock(self.matriz), 10)

    def test_reparte_y_cada_sucursal_lo_recibe_como_traslado(self):
        response = self._repartir((self.norte, 4), (self.sur, 2))
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["productos"][0]["enviado"], 6)
        # En la sucursal de la compra queda el resto; lo enviado esta en camino.
        self.assertEqual(self._stock(self.matriz), 4)
        self.assertEqual(self._stock(self.norte), 0)

        # Cada envio es un traslado aprobado con su salida y su entrada.
        traslado = SolicitudTraslado.objects.get(compra_local=self.compra, sucursal_solicitante=self.norte)
        self.assertEqual(traslado.estado, SolicitudTraslado.Estados.APROBADA)
        self.assertEqual(traslado.no_documento, f"ENV-{self.norte.id}")
        salida, entrada = traslado.movimiento_salida, traslado.movimiento_entrada
        self.assertEqual((salida.sucursal_id, salida.sucursal_objetivo_id), (self.matriz.id, self.norte.id))
        self.assertEqual((entrada.sucursal_id, entrada.sucursal_objetivo_id), (self.norte.id, self.matriz.id))
        for movimiento in (salida, entrada):
            self.assertEqual(movimiento.sub_tipo_movimiento.nombre, "Traslado")
            self.assertEqual(movimiento.estado_movimiento.nombre, "Enviado")
            self.assertEqual([(d.producto_id, d.cantidad) for d in movimiento.detalles.all()], [(self.producto.id, 4)])

        # Sale en "envios en camino" de la sucursal destino, como un traslado.
        en_camino = self.client.get(
            f"{BASE}/envios-en-camino/", {"sucursal_solicitante_id": self.norte.id}
        ).data
        self.assertEqual([row["id"] for row in en_camino], [traslado.id])

        # Se recibe con checkboxes: llegan 3 de 4, directo a su ubicacion.
        nivel = SubDivision.objects.create(
            division=Division.objects.create(
                bodega=Bodega.objects.get(sucursal=self.norte),
                tipo_division=TipoDivision.objects.get(nombre="General"),
                nombre="B1",
            ),
            nombre="01",
        )
        response = self.client.post(
            f"{BASE}/solicitudes-traslado/{traslado.id}/confirmar-recepcion/",
            {
                "resultado": "incompleto",
                "items": [
                    {
                        "producto_id": self.producto.id,
                        "cantidad_recibida": 3,
                        "ubicaciones": [{"subdivision_id": nivel.id, "cantidad": 3}],
                        "novedad": "Falto uno",
                    }
                ],
            },
            format="json",
        )
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(self._stock(self.norte), 3)
        entrada.refresh_from_db()
        self.assertEqual(entrada.estado_movimiento.nombre, "Parcialmente recibido")
        self.assertEqual(
            TrasladoInconveniente.objects.get(solicitud=traslado).cantidad_faltante, 1
        )

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
        self.assertEqual(SolicitudTraslado.objects.filter(compra_local=self.compra).count(), 1)

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
