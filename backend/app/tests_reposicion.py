import datetime
import math
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from app import reposicion
from app.models import ReposicionConfiguracion
from inventario.models import Bodega, Division, Inventario, SubDivision, Sucursal
from movimientos.models import DetalleMovimiento, MovimientoInventario
from productos.models import Producto
from tipos.models import EstadoMovimiento, EstadoProducto, SubTipoMovimiento, TipoDivision, TipoMovimiento


class ReposicionTests(TestCase):
    def setUp(self):
        reposicion._CACHE["key"] = None
        self.today = timezone.localdate()
        self.matriz = Sucursal.objects.create(nombre="9 de Octubre (Matriz)", direccion="x")
        self.norte = Sucursal.objects.create(nombre="Norte", direccion="y")
        tipo_div = TipoDivision.objects.create(nombre="Percha")
        self.sub_matriz = self._sub(self.matriz)
        self.sub_norte = self._sub(self.norte, tipo_div)
        self.salida, _ = TipoMovimiento.objects.get_or_create(nombre="Salida")
        self.venta, _ = SubTipoMovimiento.objects.get_or_create(tipo_movimiento=self.salida, nombre="Venta")
        self.estado, _ = EstadoMovimiento.objects.get_or_create(nombre="Vendido")
        self.estado_producto, _ = EstadoProducto.objects.get_or_create(nombre="Disponible")
        self.seq = 0

        self.rapido = Producto.objects.create(codigo="RAP", nombre="Rapido", precio=Decimal("20"), costo_minimo=Decimal("10"))
        self.barato = Producto.objects.create(codigo="BAR", nombre="Barato", precio=Decimal("0.2"), costo_minimo=Decimal("0.1"))
        self.raro = Producto.objects.create(codigo="RAR", nombre="Raro", precio=Decimal("5"), costo_minimo=Decimal("5"))
        self.viejo = Producto.objects.create(codigo="VIE", nombre="Viejo", precio=Decimal("5"), costo_minimo=Decimal("5"))

        # Rapido: 2 por dia, todos los dias, en la Matriz (demanda estable).
        for days_ago in range(180):
            self._sell(self.matriz, self.rapido, 2, days_ago)
        # Barato: 1 cada 2 dias (valor anual minimo -> clase C).
        for days_ago in range(0, 180, 2):
            self._sell(self.matriz, self.barato, 1, days_ago)
        # Raro: solo 2 dias con venta (esporadico).
        self._sell(self.matriz, self.raro, 3, 10)
        self._sell(self.matriz, self.raro, 1, 50)
        # Rapido tambien se vende en Norte, 1 por dia.
        for days_ago in range(180):
            self._sell(self.norte, self.rapido, 1, days_ago)

        Inventario.objects.create(producto=self.rapido, subdivision=self.sub_matriz, cantidad=5)
        Inventario.objects.create(producto=self.rapido, subdivision=self.sub_norte, cantidad=100)
        Inventario.objects.create(producto=self.barato, subdivision=self.sub_matriz, cantidad=1)
        Inventario.objects.create(producto=self.viejo, subdivision=self.sub_matriz, cantidad=7)

        config = ReposicionConfiguracion.get_global()
        config.sucursal_central = self.matriz
        config.save()

        User = get_user_model()
        self.admin = User.objects.create_superuser(username="a@a.com", email="a@a.com", password="x")
        self.client_admin = APIClient()
        self.client_admin.force_authenticate(self.admin)

    def _sub(self, sucursal, tipo=None):
        tipo = tipo or TipoDivision.objects.create(nombre=f"T-{sucursal.id}")
        bodega = Bodega.objects.create(sucursal=sucursal, nombre=f"Almacen {sucursal.nombre}")
        division = Division.objects.create(tipo_division=tipo, bodega=bodega, nombre="A1")
        return SubDivision.objects.create(division=division, nombre="1")

    def _sell(self, sucursal, producto, cantidad, days_ago):
        self.seq += 1
        movimiento = MovimientoInventario.objects.create(
            sucursal=sucursal,
            tipo_movimiento=self.salida,
            sub_tipo_movimiento=self.venta,
            estado_movimiento=self.estado,
            fecha=self.today - datetime.timedelta(days=days_ago),
            no_documento=f"V-{self.seq}",
        )
        DetalleMovimiento.objects.create(
            movimiento_inventario=movimiento,
            producto=producto,
            cantidad=cantidad,
            estado_producto=self.estado_producto,
            valor=Decimal("1"),
            valor_total=Decimal(cantidad),
        )

    def _rows(self, **overrides):
        config = ReposicionConfiguracion.get_global()
        for field, value in overrides.items():
            setattr(config, field, value)
        rows, meta = reposicion.compute_replenishment(config, today=self.today)
        return {(row["sucursal_id"], row["codigo"]): row for row in rows}, meta

    def test_demanda_estable_revision_continua_con_punto_de_pedido(self):
        rows, meta = self._rows()
        self.assertEqual(meta["sucursal_central_id"], self.matriz.id)
        row = rows[(self.matriz.id, "RAP")]
        self.assertEqual(row["clase"], "A")
        self.assertEqual(row["politica"], "continua")
        self.assertAlmostEqual(row["venta_dia"], 2.0)
        self.assertAlmostEqual(row["desviacion_dia"], 0.0)
        # L = proveedor local por defecto (3): R = 3 * 2 + 0 = 6.
        self.assertEqual(row["dias_entrega"], 3.0)
        self.assertEqual(row["punto_pedido"], 6)
        # EOQ = sqrt(2 * 730 * 10 / (10 * 25%)) = 76.4 -> 77.
        self.assertEqual(row["cantidad_pedido"], math.ceil(math.sqrt(2 * 730 * 10 / 2.5)))
        self.assertEqual(row["stock"], 5)
        self.assertEqual(row["estado"], "pedir")
        self.assertEqual(row["sugerido"], row["cantidad_pedido"])

    def test_sucursal_se_abastece_por_traslado_y_tiene_exceso(self):
        rows, _ = self._rows()
        row = rows[(self.norte.id, "RAP")]
        self.assertEqual(row["dias_entrega"], 2.0)
        self.assertEqual(row["punto_pedido"], 2)
        self.assertEqual(row["sugerido"], 0)
        # Stock maximo esperado = SS + Q (aqui SS = 0): lo que pase de eso es exceso.
        self.assertEqual(row["nivel_maximo"], math.ceil(math.sqrt(2 * 365 * 10 / 2.5)))
        self.assertEqual(row["estado"], "exceso")
        self.assertEqual(row["causa"]["exceso"], 100 - row["nivel_maximo"])

    def test_clase_c_usa_stock_base_periodico(self):
        rows, _ = self._rows()
        row = rows[(self.matriz.id, "BAR")]
        self.assertEqual(row["clase"], "C")
        self.assertEqual(row["politica"], "periodica")
        # B = (r + L) mu + z sigma sqrt(r + L), con r = 7, L = 3, mu = 0.5.
        z = reposicion._z_for(90)
        expected = (7 + 3) * 0.5 + z * row["desviacion_dia"] * math.sqrt(10)
        self.assertLessEqual(abs(row["nivel_base"] - expected), 1)
        self.assertGreater(row["stock_seguridad"], 0)
        self.assertEqual(row["sugerido"], row["nivel_base"] - 1)

    def test_esporadico_y_obsoleto(self):
        rows, _ = self._rows()
        self.assertEqual(rows[(self.matriz.id, "RAR")]["estado"], "esporadico")
        self.assertEqual(rows[(self.matriz.id, "RAR")]["sugerido"], 0)
        viejo = rows[(self.matriz.id, "VIE")]
        self.assertEqual(viejo["estado"], "obsoleto")
        self.assertEqual(viejo["causa"], {"obsoleto": 7, "en_camino": 0})

    def test_nivel_de_servicio_mas_alto_sube_el_stock_de_seguridad(self):
        bajo, _ = self._rows(nivel_servicio_c=80)
        alto, _ = self._rows(nivel_servicio_c=99.9)
        self.assertGreater(
            alto[(self.matriz.id, "BAR")]["stock_seguridad"],
            bajo[(self.matriz.id, "BAR")]["stock_seguridad"],
        )

    def test_endpoint_filtra_lo_que_hay_que_reponer_y_resume_por_causa(self):
        response = self.client_admin.get(f"/reposicion/?sucursal_id={self.matriz.id}&estado=reponer")
        self.assertEqual(response.status_code, 200, response.data)
        codes = {row["codigo"] for row in response.data["results"]}
        self.assertIn("RAP", codes)
        self.assertNotIn("VIE", codes)
        self.assertEqual(response.data["resumen"]["valor_por_causa"]["obsoleto"], 35.0)

    def test_configuracion_valida_y_guarda(self):
        response = self.client_admin.patch(
            "/reposicion/configuracion/", {"nivel_servicio_a": 99, "traslado_dias": 4}, format="json"
        )
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["traslado_dias"], 4)
        bad = self.client_admin.patch("/reposicion/configuracion/", {"corte_a": 99, "corte_b": 50}, format="json")
        self.assertEqual(bad.status_code, 400)

    def test_solo_administradores(self):
        user = get_user_model().objects.create_user(username="u@u.com", email="u@u.com", password="x")
        client = APIClient()
        client.force_authenticate(user)
        self.assertEqual(client.get("/reposicion/").status_code, 403)

    def test_detalle_de_producto_con_ventas_semanales(self):
        response = self.client_admin.get(f"/reposicion/producto/{self.rapido.id}/")
        self.assertEqual(response.status_code, 200, response.data)
        filas = response.data["filas"]
        self.assertEqual([fila["sucursal_id"] for fila in filas], [self.matriz.id, self.norte.id])
        semanas = response.data["ventas_semanales"][str(self.matriz.id)]
        self.assertEqual(sum(semana["cantidad"] for semana in semanas), 360)
        self.assertEqual(semanas[0]["cantidad"], 14)

    def test_tiempo_de_entrega_sale_de_las_importaciones_del_producto(self):
        from casa_comercial.models import CasaComercial
        from importaciones.models import Importacion, ImportacionDetalle

        casa = CasaComercial.objects.create(nombre="PROV", codigo="PROV", tipo=CasaComercial.TIPO_IMPORTACION)
        self.rapido.casas_comerciales.add(casa)
        self.barato.casas_comerciales.add(casa)
        # Otra importacion del proveedor (sin estos productos) tardo 40 dias.
        Importacion.objects.create(codigo="IMP-OTRA", casa_comercial=casa, dias_reales_entrega=40)
        propia = Importacion.objects.create(codigo="IMP-RAP", casa_comercial=casa, dias_reales_entrega=20)
        ImportacionDetalle.objects.create(importacion=propia, producto=self.rapido, cantidad=10)

        rows, _ = self._rows()
        rapido = rows[(self.matriz.id, "RAP")]
        self.assertEqual(rapido["dias_entrega"], 20.0)
        self.assertEqual(rapido["fuente_entrega"], "producto")
        self.assertEqual(rapido["importaciones_entrega"], [{"codigo": "IMP-RAP", "dias": 20}])
        # Sin importaciones propias: promedio del proveedor (40 y 20 -> 30).
        barato = rows[(self.matriz.id, "BAR")]
        self.assertEqual(barato["dias_entrega"], 30.0)
        self.assertEqual(barato["fuente_entrega"], "proveedor")
        self.assertEqual(barato["proveedor_nombre"], "PROV")
        # Las demas sucursales: traslado desde la central.
        self.assertEqual(rows[(self.norte.id, "RAP")]["fuente_entrega"], "traslado")

    def test_sugerencia_de_importacion_por_proveedor(self):
        from casa_comercial.models import CasaComercial
        from importaciones.models import Importacion, ImportacionDetalle

        importador = CasaComercial.objects.create(nombre="IMPORTA", codigo="IMP", tipo=CasaComercial.TIPO_IMPORTACION)
        local = CasaComercial.objects.create(nombre="LOCALITO", codigo="LOC", tipo=CasaComercial.TIPO_LOCAL)
        self.rapido.casas_comerciales.add(importador)
        self.barato.casas_comerciales.add(local)
        abierta = Importacion.objects.create(codigo="IMP-ABIERTA", casa_comercial=importador)
        ImportacionDetalle.objects.create(importacion=abierta, producto=self.rapido, cantidad=5)

        response = self.client_admin.get("/reposicion/sugerencia-importacion/")
        self.assertEqual(response.status_code, 200, response.data)
        grupos = {g["casa_nombre"]: g for g in response.data["proveedores"]}
        self.assertTrue(grupos["IMPORTA"]["es_importacion"])
        self.assertFalse(grupos["LOCALITO"]["es_importacion"])
        item = grupos["IMPORTA"]["items"][0]
        self.assertEqual(item["codigo"], "RAP")
        self.assertEqual(item["importaciones_abiertas"][0]["codigo"], "IMP-ABIERTA")
        # La sucursal Norte no compra: no aparece en la sugerencia.
        self.assertEqual(len(grupos["IMPORTA"]["items"]), 1)

        response = self.client_admin.post(
            "/reposicion/sugerencia-importacion/",
            {"casa_comercial_id": importador.id, "items": [{"producto_id": self.rapido.id, "cantidad": 80}]},
            format="json",
        )
        self.assertEqual(response.status_code, 201, response.data)
        creada = Importacion.objects.get(pk=response.data["id"])
        self.assertEqual(creada.estado, Importacion.ESTADO_BORRADOR)
        self.assertEqual(creada.casa_comercial_id, importador.id)
        detalle = creada.detalles.get()
        self.assertEqual((detalle.producto_id, detalle.cantidad, detalle.orden), (self.rapido.id, 80, 1))
        self.assertIn("Reposicion", detalle.comentario)

    def test_sugerencia_valida_cantidades(self):
        from casa_comercial.models import CasaComercial

        casa = CasaComercial.objects.create(nombre="X", codigo="X", tipo=CasaComercial.TIPO_IMPORTACION)
        bad = self.client_admin.post(
            "/reposicion/sugerencia-importacion/",
            {"casa_comercial_id": casa.id, "items": [{"producto_id": self.rapido.id, "cantidad": 0}]},
            format="json",
        )
        self.assertEqual(bad.status_code, 400)

    def test_busqueda_por_referencia_y_oem(self):
        from core.search_utils import attach_product_search, matching_product_ids
        from productos.models import OEM, OEMProducto, ProductoReferencia

        ProductoReferencia.objects.create(producto=self.rapido, valor="REF-998877")
        oem = OEM.objects.create(codigo="OEM-5544")
        OEMProducto.objects.create(producto=self.barato, oem=oem)

        self.assertEqual(set(matching_product_ids("998877").values_list("id", flat=True)), {self.rapido.id})
        self.assertEqual(set(matching_product_ids("oem 5544").values_list("id", flat=True)), {self.barato.id})

        response = self.client_admin.get("/reposicion/?estado=&search=REF-998877")
        self.assertEqual({row["codigo"] for row in response.data["results"]}, {"RAP"})

        rows = attach_product_search([{"producto_id": self.barato.id}])
        self.assertIn("OEM-5544", rows[0]["producto_busqueda"])
