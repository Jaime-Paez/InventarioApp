from decimal import Decimal

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone
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
            # Orden fijo por nombre de bodega/division/subdivision.
            [
                {
                    "bodega_nombre": "Bodega Principal",
                    "ubicacion": "Percha B:Nivel 2",
                    "division_nombre": "Percha B",
                    "subdivision_nombre": "Nivel 2",
                    "cantidad": 2,
                    "stock_bajo": False,
                },
                {
                    "bodega_nombre": "Bodega Respaldo",
                    "ubicacion": "Rack C:Nivel 4",
                    "division_nombre": "Rack C",
                    "subdivision_nombre": "Nivel 4",
                    "cantidad": 7,
                    "stock_bajo": False,
                },
            ],
        )
        self.assertFalse(principal_branch_payload["tiene_stock_bajo"])
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


class InventarioTablaBusquedaSufijoGuionTests(APITestCase):
    """Buscar "-L" debe traer solo los codigos con -L, no los -R."""

    def setUp(self):
        User = get_user_model()
        self.admin = User.objects.create_superuser(
            username="admin-guion@test.com", email="admin-guion@test.com", password="x"
        )
        self.client.force_authenticate(self.admin)
        tipo, _ = TipoDivision.objects.get_or_create(nombre="General")
        sucursal = Sucursal.objects.create(nombre="Norte", direccion="Av 1")
        bodega = Bodega.objects.create(sucursal=sucursal, nombre="Principal")
        division = Division.objects.create(tipo_division=tipo, bodega=bodega, nombre="Percha")
        subdivision = SubDivision.objects.create(division=division, nombre="Nivel 1")
        for codigo in ("C0634RX-LA", "C0634RX-RA", "C0634AM-L", "C0634AM-R"):
            producto = Producto.objects.create(codigo=codigo, nombre="AMORTIGUADOR DELANTERO")
            Inventario.objects.create(producto=producto, subdivision=subdivision, cantidad=1)

    def _codigos(self, **params):
        response = self.client.get("/inventario/inventario/tabla/", params)
        self.assertEqual(response.status_code, 200, response.data)
        rows = response.data.get("results", response.data) if isinstance(response.data, dict) else response.data
        return {str(row.get("codigo") or row.get("producto_codigo") or "") for row in rows}

    def test_guion_l_solo_trae_los_l(self):
        self.assertEqual(self._codigos(search="c0634 -L"), {"C0634RX-LA", "C0634AM-L"})
        self.assertEqual(self._codigos(search="-r"), {"C0634RX-RA", "C0634AM-R"})

    def test_sin_guion_sigue_igual(self):
        self.assertEqual(len(self._codigos(search="c0634")), 4)


class InventarioTablaUbicacionesStockBajoTests(APITestCase):
    """Ojo en rojo cuando una ubicacion de OTRA bodega tiene mas que la
    principal. Las de bodega ("Bodega Norte") siempre son secundarias; las del
    mismo almacen que la principal son todas principales (entre ellas no hay
    rojo). Las columnas Ub. se ordenan por la cantidad de la principal."""

    def setUp(self):
        User = get_user_model()
        self.admin = User.objects.create_superuser(
            username="admin-bajo@test.com", email="admin-bajo@test.com", password="x"
        )
        self.client.force_authenticate(self.admin)
        tipo, _ = TipoDivision.objects.get_or_create(nombre="General")
        self.sucursal = Sucursal.objects.create(nombre="Norte", direccion="Av 1")
        almacen = Bodega.objects.create(sucursal=self.sucursal, nombre="Almacén Norte")
        bodega = Bodega.objects.create(sucursal=self.sucursal, nombre="Bodega Norte")
        division = Division.objects.create(tipo_division=tipo, bodega=almacen, nombre="Percha")
        division_bodega = Division.objects.create(tipo_division=tipo, bodega=bodega, nombre="Rack")
        self.sub_a = SubDivision.objects.create(division=division, nombre="A")
        self.sub_b = SubDivision.objects.create(division=division, nombre="B")
        self.sub_c = SubDivision.objects.create(division=division_bodega, nombre="C")
        self.productos = {}

        def producto(codigo, cantidades):
            item = Producto.objects.create(codigo=codigo, nombre=f"PRODUCTO {codigo}")
            for subdivision, cantidad in zip((self.sub_a, self.sub_b, self.sub_c), cantidades):
                if cantidad is not None:
                    Inventario.objects.create(producto=item, subdivision=subdivision, cantidad=cantidad)
            self.productos[codigo] = item
            return item

        # Columnas: A y B (almacen), C (bodega).
        producto("BAJO-PRINC1", [1, 20, None])     # A y B del mismo almacen: ambas principales -> normal
        producto("BAJO-OTRA", [50, 1, None])       # principal A=50 -> normal
        producto("BAJO-CERO", [0, 20, None])       # sin orden: principal B=20 (con stock) -> normal
        producto("BAJO-DOS", [2, 50, None])        # mismo almacen -> normal
        producto("BAJO-UNA", [1, None, None])      # una sola ubicacion -> sin ojo, normal
        producto("BAJO-SINSTOCK", [0, 0, None])    # sin stock -> celda vacia
        producto("BAJO-BOD", [3, None, 10])        # la bodega tiene mas que el almacen -> rojo
        producto("BAJO-SOLOBOD", [0, None, 5])     # almacen vacio, todo en bodega -> rojo

    def _rows(self, **params):
        response = self.client.get("/inventario/inventario/tabla/", params)
        self.assertEqual(response.status_code, 200, response.data)
        rows = response.data.get("results", response.data) if isinstance(response.data, dict) else response.data
        return [row for row in rows if str(row.get("codigo") or "").startswith("BAJO-")]

    def _ubicacion(self, row):
        return row.get(f"ubicacion_sucursal_{self.sucursal.id}") or {}

    def _payloads(self):
        return {row["codigo"]: self._ubicacion(row) for row in self._rows()}

    def _ordenar(self, codigo, subdivisiones):
        response = self.client.post(
            "/inventario/inventario/orden-ubicaciones/",
            {
                "producto_id": self.productos[codigo].id,
                "sucursal_id": self.sucursal.id,
                "subdivision_ids": [sub.id for sub in subdivisiones],
            },
            format="json",
        )
        self.assertEqual(response.status_code, 200, response.data)

    def test_rojo_solo_cuando_otra_bodega_tiene_mas_que_la_principal(self):
        rows = self._payloads()
        rojos = {codigo for codigo, payload in rows.items() if payload.get("tiene_stock_bajo")}
        # Dos filas del mismo almacen (A=1, B=20) no prenden el ojo.
        self.assertEqual(rojos, {"BAJO-BOD", "BAJO-SOLOBOD"})
        self.assertFalse(rows["BAJO-PRINC1"]["principal"]["stock_bajo"])
        self.assertTrue(rows["BAJO-BOD"]["principal"]["stock_bajo"])
        self.assertEqual(rows["BAJO-CERO"]["principal"]["cantidad"], 20)
        self.assertEqual(rows["BAJO-SINSTOCK"], {})
        # La bodega nunca es principal: aunque tenga mas, la principal es del almacen.
        self.assertEqual(rows["BAJO-BOD"]["principal"]["bodega_nombre"], "Almacén Norte")
        self.assertEqual(rows["BAJO-SOLOBOD"]["principal"]["cantidad"], 0)
        # Solo la principal se marca; las demas son respaldo.
        self.assertEqual(
            [loc["stock_bajo"] for loc in rows["BAJO-PRINC1"]["ubicaciones_adicionales"]], [False]
        )

    def test_el_orden_elegido_decide_la_principal_pero_la_bodega_sigue_secundaria(self):
        # La de 0 puesta primera: la otra (mismo almacen) tiene mas, pero no es rojo.
        self._ordenar("BAJO-CERO", [self.sub_a, self.sub_b])
        # La de 1 puesta primera: mismo almacen -> tampoco.
        self._ordenar("BAJO-OTRA", [self.sub_b, self.sub_a])
        # La bodega puesta primera: igual queda secundaria.
        self._ordenar("BAJO-BOD", [self.sub_c, self.sub_a])
        # La de mas cantidad puesta primera: deja de ser rojo.
        self._ordenar("BAJO-PRINC1", [self.sub_b, self.sub_a])

        rows = self._payloads()
        self.assertFalse(rows["BAJO-CERO"]["tiene_stock_bajo"])
        self.assertEqual(rows["BAJO-CERO"]["principal"]["cantidad"], 0)
        self.assertFalse(rows["BAJO-OTRA"]["tiene_stock_bajo"])
        self.assertEqual(rows["BAJO-OTRA"]["ubicacion_principal"], rows["BAJO-OTRA"]["principal"]["ubicacion"])
        self.assertEqual(rows["BAJO-BOD"]["principal"]["bodega_nombre"], "Almacén Norte")
        self.assertTrue(rows["BAJO-BOD"]["tiene_stock_bajo"])
        self.assertFalse(rows["BAJO-PRINC1"]["tiene_stock_bajo"])
        self.assertEqual(rows["BAJO-PRINC1"]["principal"]["cantidad"], 20)

    def test_orden_por_nombre_de_la_principal_y_vacias_al_final(self):
        from .viewsets import location_label_sort_key

        labels = ["01:10:02", "SIN UBICACION:SIN UBICACION", "1A:10:05", "MOSTRADOR:01", "01:02:01", "1A:01:03", "14:01"]
        self.assertEqual(
            sorted(labels, key=location_label_sort_key),
            ["1A:01:03", "1A:10:05", "01:02:01", "01:10:02", "14:01", "MOSTRADOR:01", "SIN UBICACION:SIN UBICACION"],
        )
        branch = self.sucursal.id
        # Principales: Percha:A (PRINC1 1, OTRA 50, DOS 2, UNA 1, BOD 3,
        # SOLOBOD 0) y Percha:B (CERO 20); SINSTOCK sin celda.
        asc = [row["codigo"] for row in self._rows(ordering=f"ubicacion_sucursal_{branch}")]
        # Misma ubicacion: la de mas unidades primero.
        self.assertEqual(asc[:3], ["BAJO-OTRA", "BAJO-BOD", "BAJO-DOS"])
        self.assertEqual(set(asc[3:5]), {"BAJO-PRINC1", "BAJO-UNA"})
        self.assertEqual(asc[5], "BAJO-SOLOBOD")
        self.assertEqual(asc[-2:], ["BAJO-CERO", "BAJO-SINSTOCK"])
        desc = [row["codigo"] for row in self._rows(ordering=f"-ubicacion_sucursal_{branch}")]
        self.assertEqual(desc[0], "BAJO-CERO")
        self.assertEqual(desc[-1], "BAJO-SINSTOCK")

    def test_filtro_restock_bodega_devuelve_solo_los_de_ojo_rojo(self):
        branch = str(self.sucursal.id)
        rojos = {row["codigo"] for row in self._rows(restock_bodega="1", restock_sucursal=branch)}
        esperados = {
            row["codigo"] for row in self._rows() if self._ubicacion(row).get("tiene_stock_bajo")
        }
        self.assertEqual(rojos, esperados)
        self.assertEqual(rojos, {"BAJO-BOD", "BAJO-SOLOBOD"})
        otra = Sucursal.objects.create(nombre="Sur", direccion="Av 2")
        self.assertEqual(self._rows(restock_bodega="1", restock_sucursal=str(otra.id)), [])
        # Junto con el orden por cantidad sigue funcionando.
        self.assertEqual(
            {row["codigo"] for row in self._rows(
                restock_bodega="1", restock_sucursal=branch, ordering=f"-ubicacion_sucursal_{branch}"
            )},
            rojos,
        )

    def test_filtros_de_stock_precio_y_datos_incompletos(self):
        from productos.models import ProductoReferencia

        codigos = {row["codigo"] for row in self._rows()}
        self.assertNotIn("BAJO-SINSTOCK", {row["codigo"] for row in self._rows(stock="con")})
        self.assertEqual({row["codigo"] for row in self._rows(stock="sin")}, {"BAJO-SINSTOCK"})

        Producto.objects.filter(codigo="BAJO-CERO").update(precio=Decimal("25.00"), costo_minimo=Decimal("10"))
        Producto.objects.filter(codigo="BAJO-DOS").update(precio=Decimal("80.00"))
        self.assertEqual(
            {row["codigo"] for row in self._rows(precio_min="20", precio_max="50")}, {"BAJO-CERO"}
        )
        self.assertEqual(
            {row["codigo"] for row in self._rows(costo_min="5", costo_max="15")}, {"BAJO-CERO"}
        )
        sin_precio = {row["codigo"] for row in self._rows(sin_precio="1")}
        self.assertEqual(sin_precio, codigos - {"BAJO-CERO", "BAJO-DOS"})
        self.assertEqual({row["codigo"] for row in self._rows(sin_oem="1")}, codigos)
        self.assertEqual({row["codigo"] for row in self._rows(sin_casa="1")}, codigos)

        ProductoReferencia.objects.create(producto=self.productos["BAJO-UNA"], valor="REF-XYZ-9")
        self.assertEqual({row["codigo"] for row in self._rows(referencia="xyz-9")}, {"BAJO-UNA"})

        hoy = timezone.localdate().isoformat()
        self.assertEqual({row["codigo"] for row in self._rows(fecha_desde=hoy, fecha_hasta=hoy)}, codigos)
        self.assertEqual(self._rows(fecha_desde="2000-01-01", fecha_hasta="2000-01-02"), [])

    def test_orden_rechaza_ubicaciones_de_otra_sucursal(self):
        otra = Sucursal.objects.create(nombre="Sur", direccion="Av 2")
        tipo, _ = TipoDivision.objects.get_or_create(nombre="General")
        division = Division.objects.create(
            tipo_division=tipo, bodega=Bodega.objects.create(sucursal=otra, nombre="Almacén Sur"), nombre="P"
        )
        ajena = SubDivision.objects.create(division=division, nombre="X")
        response = self.client.post(
            "/inventario/inventario/orden-ubicaciones/",
            {
                "producto_id": self.productos["BAJO-OTRA"].id,
                "sucursal_id": self.sucursal.id,
                "subdivision_ids": [self.sub_a.id, ajena.id],
            },
            format="json",
        )
        self.assertEqual(response.status_code, 400)
