from decimal import Decimal

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APITestCase

from app.models import UsuarioPreferencia
from productos.models import Producto
from tipos.models import TipoDivision

from .models import Bodega, Division, Inventario, SubDivision, Sucursal
from .viewsets import InventarioViewSet


class InventarioTableLocationPayloadTests(TestCase):
    def setUp(self):
        self.viewset = InventarioViewSet()
        self.tipo_division, _ = TipoDivision.objects.get_or_create(nombre="General")
        self.sucursal_principal = Sucursal.objects.create(
            nombre="9 de Octubre",
            direccion="Centro",
        )
        self.sucursal_secundaria = Sucursal.objects.create(
            nombre="Norte",
            direccion="Av. Principal",
        )
        self.producto = Producto.objects.create(
            codigo="INV-LOC-001",
            nombre="Producto con ubicaciones",
            precio=Decimal("25.00"),
        )

        self.subdivision_principal = self._ensure_subdivision(
            sucursal=self.sucursal_principal,
            bodega_nombre="Bodega Principal",
            division_nombre="Percha A",
            subdivision_nombre="Nivel 1",
        )
        self.subdivision_secundaria = self._ensure_subdivision(
            sucursal=self.sucursal_principal,
            bodega_nombre="Bodega Principal",
            division_nombre="Percha B",
            subdivision_nombre="Nivel 2",
        )
        self.subdivision_respaldo = self._ensure_subdivision(
            sucursal=self.sucursal_principal,
            bodega_nombre="Bodega Respaldo",
            division_nombre="Rack C",
            subdivision_nombre="Nivel 4",
        )
        self.subdivision_norte = self._ensure_subdivision(
            sucursal=self.sucursal_secundaria,
            bodega_nombre="Bodega Norte",
            division_nombre="Zona 1",
            subdivision_nombre="Fila 3",
        )

        Inventario.objects.create(
            producto=self.producto,
            subdivision=self.subdivision_principal,
            referencia="L1",
            cantidad=5,
        )
        Inventario.objects.create(
            producto=self.producto,
            subdivision=self.subdivision_principal,
            referencia="L2",
            cantidad=3,
        )
        Inventario.objects.create(
            producto=self.producto,
            subdivision=self.subdivision_secundaria,
            referencia="",
            cantidad=2,
        )
        Inventario.objects.create(
            producto=self.producto,
            subdivision=self.subdivision_respaldo,
            referencia="",
            cantidad=7,
        )
        Inventario.objects.create(
            producto=self.producto,
            subdivision=self.subdivision_norte,
            referencia="",
            cantidad=6,
        )

    def _ensure_subdivision(
        self,
        *,
        sucursal,
        bodega_nombre,
        division_nombre,
        subdivision_nombre,
    ):
        bodega, _ = Bodega.objects.get_or_create(
            sucursal=sucursal,
            nombre=bodega_nombre,
        )
        division, _ = Division.objects.get_or_create(
            bodega=bodega,
            nombre=division_nombre,
            defaults={"tipo_division": self.tipo_division},
        )
        return SubDivision.objects.get_or_create(
            division=division,
            nombre=subdivision_nombre,
        )[0]

    def test_build_branch_location_payloads_groups_locations_by_branch(self):
        payload = self.viewset._build_branch_location_payloads(
            [self.producto.id],
            [self.sucursal_principal.id, self.sucursal_secundaria.id],
        )

        self.assertIn(self.producto.id, payload)
        principal_branch_payload = payload[self.producto.id][self.sucursal_principal.id]
        secondary_branch_payload = payload[self.producto.id][self.sucursal_secundaria.id]

        self.assertEqual(
            principal_branch_payload["ubicacion_principal"],
            "Percha A:Nivel 1",
        )
        self.assertEqual(
            principal_branch_payload["principal"]["bodega_nombre"],
            "Bodega Principal",
        )
        self.assertEqual(principal_branch_payload["principal"]["cantidad"], 8)
        self.assertEqual(principal_branch_payload["total_ubicaciones"], 3)
        self.assertEqual(
            principal_branch_payload["ubicaciones_adicionales"],
            [
                {
                    "bodega_nombre": "Bodega Respaldo",
                    "ubicacion": "Rack C:Nivel 4",
                    "division_nombre": "Rack C",
                    "subdivision_nombre": "Nivel 4",
                    "cantidad": 7,
                },
                {
                    "bodega_nombre": "Bodega Principal",
                    "ubicacion": "Percha B:Nivel 2",
                    "division_nombre": "Percha B",
                    "subdivision_nombre": "Nivel 2",
                    "cantidad": 2,
                },
            ],
        )
        self.assertEqual(
            secondary_branch_payload["ubicacion_principal"],
            "Zona 1:Fila 3",
        )
        self.assertEqual(secondary_branch_payload["ubicaciones_adicionales"], [])

    def test_serialize_inventory_table_rows_includes_branch_location_columns(self):
        rows = [
            {
                "producto_id": self.producto.id,
                "codigo": self.producto.codigo,
                "nombre": self.producto.nombre,
                "descripcion": self.producto.descripcion,
                "referencia": self.producto.referencia,
                "costo_minimo": None,
                "precio": self.producto.precio,
                "creado_en": self.producto.creado_en,
                "total_general": 23,
                f"sucursal_{self.sucursal_principal.id}": 17,
                f"sucursal_{self.sucursal_secundaria.id}": 6,
            }
        ]

        serialized = self.viewset._serialize_inventory_table_rows(
            rows,
            [self.sucursal_principal, self.sucursal_secundaria],
        )

        self.assertEqual(len(serialized), 1)
        item = serialized[0]
        self.assertEqual(
            item[f"ubicacion_sucursal_{self.sucursal_principal.id}"][
                "ubicacion_principal"
            ],
            "Percha A:Nivel 1",
        )
        self.assertEqual(
            item[f"ubicacion_sucursal_{self.sucursal_secundaria.id}"]["principal"][
                "bodega_nombre"
            ],
            "Bodega Norte",
        )
        self.assertEqual(
            item[f"ubicacion_sucursal_{self.sucursal_principal.id}"]["principal"][
                "cantidad"
            ],
            8,
        )


class SubDivisionPageSizeTests(APITestCase):
    """
    Varias pantallas (recepcion de envios, resolver ubicaciones faltantes)
    piden un solo fetch con un page_size grande asumiendo que van a recibir
    todo, sin paginar. Antes, DRF recortaba en silencio cualquier page_size
    pedido a un maximo de 500 (StandardResultsSetPagination.max_page_size),
    asi que una sucursal con mas de 500 subdivisiones (la mas grande hoy
    tiene 775) perdia ubicaciones sin ningun error visible.
    """

    def setUp(self):
        user_model = get_user_model()
        self.user = user_model.objects.create_user(
            username="page_size_tester",
            email="page_size_tester@example.com",
            password="test12345",
        )
        UsuarioPreferencia.objects.get_or_create(usuario=self.user, defaults={"es_administrador": True})
        self.client.force_authenticate(user=self.user)

        tipo_division, _ = TipoDivision.objects.get_or_create(nombre="General")
        sucursal = Sucursal.objects.create(nombre="Sucursal Grande", direccion="Test")
        bodega = Bodega.objects.create(sucursal=sucursal, nombre="Bodega Grande")
        division = Division.objects.create(bodega=bodega, tipo_division=tipo_division, nombre="Division Grande")

        # Mas que el limite viejo (500) para probar que ya no se recorta ahi.
        SubDivision.objects.bulk_create(
            [SubDivision(division=division, nombre=f"Sub-{i}") for i in range(520)]
        )
        self.sucursal_id = sucursal.id

    def test_page_size_grande_no_se_recorta_a_500(self):
        response = self.client.get(
            f"/inventario/subdivisiones/?page_size=2000&sucursal_id={self.sucursal_id}"
        )
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["count"], 520)
        self.assertEqual(len(response.data["results"]), 520)


class InventarioTablaBusquedaEnieTests(APITestCase):
    """La busqueda de la tabla de Inventario no debe ignorar la ñ."""

    def setUp(self):
        User = get_user_model()
        self.admin = User.objects.create_superuser(
            username="admin-enie@test.com", email="admin-enie@test.com", password="x"
        )
        self.client.force_authenticate(self.admin)
        tipo, _ = TipoDivision.objects.get_or_create(nombre="General")
        sucursal = Sucursal.objects.create(nombre="Norte", direccion="Av 1")
        bodega = Bodega.objects.create(sucursal=sucursal, nombre="Principal")
        division = Division.objects.create(tipo_division=tipo, bodega=bodega, nombre="Percha")
        subdivision = SubDivision.objects.create(division=division, nombre="Nivel 1")
        self.pinon = Producto.objects.create(codigo="ENIE-01", nombre="PIÑON DE CAJA 208")
        otro = Producto.objects.create(codigo="ENIE-02", nombre="FILTRO DE ACEITE")
        Inventario.objects.create(producto=self.pinon, subdivision=subdivision, cantidad=3)
        Inventario.objects.create(producto=otro, subdivision=subdivision, cantidad=2)

    def _codigos(self, **params):
        response = self.client.get("/inventario/inventario/tabla/", params)
        self.assertEqual(response.status_code, 200, response.data)
        rows = response.data.get("results", response.data) if isinstance(response.data, dict) else response.data
        return {str(row.get("codigo") or row.get("producto_codigo") or "") for row in rows}

    def test_busqueda_general_encuentra_pinon_con_o_sin_enie(self):
        for termino in ("piñon", "pinon", "PIÑÓN", "piñon caja"):
            with self.subTest(termino=termino):
                codigos = self._codigos(search=termino)
                self.assertIn("ENIE-01", codigos)
                self.assertNotIn("ENIE-02", codigos)

    def test_filtro_por_nombre_encuentra_pinon_sin_enie(self):
        self.assertIn("ENIE-01", self._codigos(nombre="pinon"))
