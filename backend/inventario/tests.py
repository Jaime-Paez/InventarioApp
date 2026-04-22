from decimal import Decimal

from django.test import TestCase

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
        self.assertEqual(principal_branch_payload["total_ubicaciones"], 3)
        self.assertEqual(
            principal_branch_payload["ubicaciones_adicionales"],
            [
                {
                    "bodega_nombre": "Bodega Respaldo",
                    "ubicacion": "Rack C:Nivel 4",
                    "division_nombre": "Rack C",
                    "subdivision_nombre": "Nivel 4",
                },
                {
                    "bodega_nombre": "Bodega Principal",
                    "ubicacion": "Percha B:Nivel 2",
                    "division_nombre": "Percha B",
                    "subdivision_nombre": "Nivel 2",
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
                "pieza_original_num": 0,
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
