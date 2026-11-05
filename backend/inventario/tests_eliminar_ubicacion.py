from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from productos.models import Producto
from tipos.models import TipoDivision

from .models import Bodega, Division, Inventario, SubDivision, Sucursal


class EliminarUbicacionConStockTests(APITestCase):
    """Una ubicacion del plano (division) o una subdivision con productos
    asignados (aunque esten en 0) no se puede eliminar; el mensaje dice
    cuales productos son."""

    def setUp(self):
        tipo, _ = TipoDivision.objects.get_or_create(nombre="General")
        sucursal = Sucursal.objects.create(nombre="Elim Norte", direccion="Av 1")
        self.bodega = Bodega.objects.create(
            sucursal=sucursal,
            nombre="Principal",
            ubicaciones=[{"id": "u1", "nombre": "Percha"}, {"id": "u2", "nombre": "Vacia"}],
        )
        self.division = Division.objects.create(tipo_division=tipo, bodega=self.bodega, nombre="Percha")
        self.vacia = Division.objects.create(tipo_division=tipo, bodega=self.bodega, nombre="Vacia")
        self.sub = SubDivision.objects.create(division=self.division, nombre="A")
        self.sub_cero = SubDivision.objects.create(division=self.vacia, nombre="B")
        self.sub_libre = SubDivision.objects.create(division=self.vacia, nombre="C")
        self.producto = Producto.objects.create(codigo="EL-01", nombre="Filtro")
        Inventario.objects.create(producto=self.producto, subdivision=self.sub, cantidad=4)
        Inventario.objects.create(producto=self.producto, subdivision=self.sub_cero, cantidad=0)
        user = get_user_model().objects.create_superuser(username="el", email="el@x.com", password="x")
        self.client.force_authenticate(user)

    def test_subdivision_con_stock_no_se_elimina_y_dice_productos(self):
        response = self.client.delete(f"/inventario/subdivisiones/{self.sub.id}/")
        self.assertEqual(response.status_code, 400, response.content)
        self.assertEqual(response.data["code"], "ubicacion_con_stock")
        self.assertIn("EL-01 (4)", response.data["detail"])
        self.assertTrue(SubDivision.objects.filter(id=self.sub.id).exists())

    def test_subdivision_con_producto_en_cero_tampoco_se_elimina(self):
        response = self.client.delete(f"/inventario/subdivisiones/{self.sub_cero.id}/")
        self.assertEqual(response.status_code, 400, response.content)
        self.assertIn("EL-01 (0)", response.data["detail"])

    def test_subdivision_sin_productos_se_elimina(self):
        response = self.client.delete(f"/inventario/subdivisiones/{self.sub_libre.id}/")
        self.assertEqual(response.status_code, 204, response.content)

    def test_division_con_stock_no_se_elimina(self):
        response = self.client.delete(f"/inventario/divisiones/{self.division.id}/")
        self.assertEqual(response.status_code, 400, response.content)
        self.assertIn("EL-01 (4)", response.data["detail"])
        self.assertEqual(Inventario.objects.filter(subdivision=self.sub).get().cantidad, 4)

    def test_consulta_productos_con_stock(self):
        response = self.client.get(f"/inventario/divisiones/{self.division.id}/productos-con-stock/")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.data["productos"][0]["codigo"], "EL-01")
        con_cero = self.client.get(f"/inventario/divisiones/{self.vacia.id}/productos-con-stock/")
        self.assertEqual(con_cero.data["productos"][0]["cantidad"], 0)

    def _put_bodega(self, ubicaciones):
        return self.client.put(
            f"/inventario/bodegas/{self.bodega.id}/",
            {"nombre": "Principal", "sucursal_id": self.bodega.sucursal_id, "ubicaciones": ubicaciones},
            format="json",
        )

    def test_quitar_ubicacion_del_plano_con_stock_se_bloquea(self):
        response = self._put_bodega([{"id": "u2", "nombre": "Vacia"}])
        self.assertEqual(response.status_code, 400, response.content)
        self.assertIn("Percha", response.data["detail"])
        self.assertIn("EL-01 (4)", response.data["detail"])

    def test_quitar_ubicacion_con_producto_en_cero_se_bloquea(self):
        response = self._put_bodega([{"id": "u1", "nombre": "Percha"}])
        self.assertEqual(response.status_code, 400, response.content)
        self.assertIn("Vacia", response.data["detail"])

    def test_quitar_ubicacion_sin_productos_se_permite(self):
        Inventario.objects.filter(subdivision__division=self.vacia).delete()
        response = self._put_bodega([{"id": "u1", "nombre": "Percha"}])
        self.assertEqual(response.status_code, 200, response.content)
