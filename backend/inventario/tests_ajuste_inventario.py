from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from movimientos.historial_producto import build_product_movement_history
from productos.models import Producto
from tipos.models import TipoDivision

from .models import AjusteInventario, Bodega, Division, Inventario, SubDivision, Sucursal

URL = "/inventario/inventario/ajustar/"


class AjusteInventarioTests(APITestCase):
    """Editar cantidades de un producto: si cambia el total de la sucursal es
    un ajuste con motivo y sale en el Kardex; repartir entre ubicaciones no."""

    def setUp(self):
        tipo, _ = TipoDivision.objects.get_or_create(nombre="General")
        self.sucursal = Sucursal.objects.create(nombre="Ajustes Norte", direccion="Av 1")
        bodega = Bodega.objects.create(sucursal=self.sucursal, nombre="Principal")
        division = Division.objects.create(tipo_division=tipo, bodega=bodega, nombre="Percha")
        self.sub_a = SubDivision.objects.create(division=division, nombre="A")
        self.sub_b = SubDivision.objects.create(division=division, nombre="B")
        self.producto = Producto.objects.create(codigo="AJ-01", nombre="Filtro")
        self.inv_a = Inventario.objects.create(producto=self.producto, subdivision=self.sub_a, cantidad=5)
        user = get_user_model().objects.create_superuser(username="aj", email="aj@x.com", password="x")
        self.client.force_authenticate(user)

    def test_pide_motivo_y_registra_el_ajuste(self):
        body = {"producto_id": self.producto.id, "cambios": [{"id": self.inv_a.id, "subdivision_id": self.sub_a.id, "cantidad": 3}]}
        response = self.client.post(URL, body, format="json")
        self.assertEqual(response.status_code, 400, response.content)
        self.assertEqual(response.data["code"], "motivo_requerido")
        self.assertEqual(response.data["ajustes"][0]["diferencia"], -2)
        self.inv_a.refresh_from_db()
        self.assertEqual(self.inv_a.cantidad, 5)  # no se guardo nada

        response = self.client.post(URL, {**body, "motivo": "No encontré"}, format="json")
        self.assertEqual(response.status_code, 200, response.content)
        self.inv_a.refresh_from_db()
        self.assertEqual(self.inv_a.cantidad, 3)
        ajuste = AjusteInventario.objects.get(producto=self.producto)
        self.assertEqual((ajuste.cantidad_anterior, ajuste.cantidad_nueva, ajuste.diferencia), (5, 3, -2))
        self.assertEqual(ajuste.motivo, "No encontré")

        data = build_product_movement_history(self.producto.id, sucursal_id=self.sucursal.id)
        row = data["results"][-1]
        self.assertEqual(row["tipo"], "ajuste")
        self.assertEqual(row["diferencia"], -2)
        self.assertEqual(row["origen"], "Ajuste · No encontré")
        self.assertEqual(data["totales"]["ajustes"], -2)
        self.assertEqual(build_product_movement_history(self.producto.id, tipo="ajuste")["count"], 1)
        self.assertEqual(build_product_movement_history(self.producto.id, tipo="salida")["count"], 0)

    def test_repartir_en_la_misma_sucursal_no_es_ajuste(self):
        body = {
            "producto_id": self.producto.id,
            "cambios": [
                {"id": self.inv_a.id, "subdivision_id": self.sub_a.id, "cantidad": 0},
                {"subdivision_id": self.sub_b.id, "cantidad": 5},
            ],
        }
        response = self.client.post(URL, body, format="json")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.data["ajustes"], [])
        self.assertFalse(Inventario.objects.filter(id=self.inv_a.id).exists())
        self.assertEqual(Inventario.objects.get(producto=self.producto, subdivision=self.sub_b).cantidad, 5)
        self.assertFalse(AjusteInventario.objects.exists())

    def test_sumar_en_ubicacion_nueva(self):
        body = {"producto_id": self.producto.id, "motivo": "Ajuste de inventario", "cambios": [{"subdivision_id": self.sub_b.id, "cantidad": 2}]}
        response = self.client.post(URL, body, format="json")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.data["ajustes"][0]["diferencia"], 2)
        self.assertEqual(response.data["ajustes"][0]["cantidad_nueva"], 7)

    def test_no_encontre_solo_cuando_baja(self):
        sube = {"producto_id": self.producto.id, "motivo": "No encontré", "cambios": [{"subdivision_id": self.sub_b.id, "cantidad": 2}]}
        response = self.client.post(URL, sube, format="json")
        self.assertEqual(response.status_code, 400, response.content)
        self.assertFalse(Inventario.objects.filter(producto=self.producto, subdivision=self.sub_b).exists())
        self.assertFalse(AjusteInventario.objects.exists())
