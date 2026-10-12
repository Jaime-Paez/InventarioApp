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
