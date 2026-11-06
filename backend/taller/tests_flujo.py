from decimal import Decimal

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from productos.models import Producto
from usuarios.models import Rol

BASE = "/taller/ordenes"
FIRMA = "data:image/png;base64,iVBORw0KGgo="


class FlujoTallerTests(TestCase):
    """Despacho con firma, stock en taller, pruebas, devoluciones, cierre y garantia."""

    def setUp(self):
        from casa_comercial.models import CasaComercial
        from inventario.models import Bodega, Division, Inventario, Sucursal, SubDivision
        from tipos.models import EstadoMovimiento, EstadoProducto, TipoDivision, TipoMovimiento

        User = get_user_model()
        self.admin = User.objects.create_superuser(username="adm@t.com", email="adm@t.com", password="x")
        self.asistente = User.objects.create_user(username="as@t.com", email="as@t.com", password="x")
        Rol.objects.get(nombre="Asistente de servicio").usuarios.add(self.asistente)
        self.api = APIClient()
        self.api.force_authenticate(self.asistente)
        self.admin_api = APIClient()
        self.admin_api.force_authenticate(self.admin)

        TipoMovimiento.objects.get_or_create(nombre="Salida")
        EstadoMovimiento.objects.get_or_create(nombre="Vendido")
        EstadoProducto.objects.get_or_create(nombre="Nuevo")

        self.sucursal, _ = Sucursal.objects.get_or_create(nombre="9 de Octubre (Matriz)", defaults={"direccion": "x"})
        bodega = Bodega.objects.create(sucursal=self.sucursal, nombre="Almacen")
        tipo = TipoDivision.objects.create(nombre="Percha")
        division = Division.objects.create(bodega=bodega, nombre="A", tipo_division=tipo)
        self.sub1 = SubDivision.objects.create(division=division, nombre="1")
        self.sub2 = SubDivision.objects.create(division=division, nombre="2")
        self.casa_cl = CasaComercial.objects.create(nombre="Casa CL", codigo="CL")
        self.casa_px = CasaComercial.objects.create(nombre="Casa PX", codigo="PX")
        self.filtro = Producto.objects.create(codigo="P1268CL", nombre="Filtro", precio=Decimal("12.00"))
        self.filtro.casas_comerciales.add(self.casa_cl)
        self.bujia = Producto.objects.create(codigo="C0104", nombre="Bujia", precio=Decimal("5.00"))
        Inventario.objects.create(producto=self.filtro, subdivision=self.sub1, cantidad=5)
        Inventario.objects.create(producto=self.bujia, subdivision=self.sub2, cantidad=10)

    def _stock(self, producto):
        from inventario.models import Inventario

        return sum(Inventario.objects.filter(producto=producto).values_list("cantidad", flat=True))

    def _orden_de_trabajo(self, **lineas):
        orden = self.api.post(f"{BASE}/", {"placa": "PFI-8991", "sucursal": self.sucursal.id}, format="json").json()
        for producto, cantidad in lineas.items():
            p = getattr(self, producto)
            self.api.post(
                f"{BASE}/{orden['id']}/lineas/",
                {"tipo": "repuesto", "producto": p.id, "cantidad": cantidad},
                format="json",
            )
        self.api.post(
            f"{BASE}/{orden['id']}/lineas/", {"tipo": "mano_obra", "descripcion": "Cambio", "precio": "20"}, format="json"
        )
        return self.api.post(f"{BASE}/{orden['id']}/aceptar/").json()

    def _entregar(self, orden_id, items, client=None):
        return (client or self.admin_api).post(
            f"{BASE}/{orden_id}/entregas/",
            {"recibido_por": "Wilmer", "recibido_rol": "Tecnico", "firma": FIRMA, "items": items},
            format="json",
        )

    def test_despacho_completo_y_cierre(self):
        orden = self._orden_de_trabajo(filtro=2, bujia=4)
        lineas = {l["producto_codigo"]: l for l in orden["lineas"] if l["tipo"] == "repuesto"}
        # Solo el admin despacha, y exige firma.
        r = self._entregar(orden["id"], [{"linea": lineas["C0104"]["id"], "cantidad": 4}], self.api)
        self.assertEqual(r.status_code, 403)
        sin_firma = self.admin_api.post(
            f"{BASE}/{orden['id']}/entregas/",
            {"recibido_por": "W", "items": [{"linea": lineas["C0104"]["id"], "cantidad": 1}]},
            format="json",
        )
        self.assertEqual(sin_firma.status_code, 400)

        r = self._entregar(
            orden["id"],
            [{"linea": lineas["C0104"]["id"], "cantidad": 4}, {"linea": lineas["P1268CL"]["id"], "cantidad": 2}],
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(self._stock(self.bujia), 6)
        self.assertEqual(self._stock(self.filtro), 3)
        data = r.json()
        self.assertEqual(data["entregas"][0]["recibido_por"], "Wilmer")
        self.assertEqual(sum(l["pendiente_despacho"] for l in data["lineas"]), 0)

        from taller.stock import en_taller_por_producto_sucursal

        en_taller = en_taller_por_producto_sucursal([self.bujia.id])
        self.assertEqual(en_taller[(self.bujia.id, self.sucursal.id)]["cantidad"], 4)

        cerrada = self.api.post(f"{BASE}/{orden['id']}/cerrar/", {"numero_factura": "001-001-123"}, format="json")
        self.assertEqual(cerrada.status_code, 200, cerrada.content)
        data = cerrada.json()
        self.assertEqual(data["estado"], "cerrada")
        self.assertTrue(data["salida_documento"].startswith("OT-"))
        # La salida no vuelve a descontar.
        self.assertEqual(self._stock(self.bujia), 6)
        self.assertEqual(en_taller_por_producto_sucursal([self.bujia.id]), {})
        from movimientos.models import MovimientoInventario

        salida = MovimientoInventario.objects.get(orden_taller__id=orden["id"])
        self.assertEqual(salida.sub_tipo_movimiento.nombre, "Taller")
        self.assertEqual(salida.detalles.count(), 2)

    def test_no_despacha_sin_stock_ni_precio_aprobado(self):
        orden = self._orden_de_trabajo(filtro=9)
        linea = next(l for l in orden["lineas"] if l["tipo"] == "repuesto")
        self.assertEqual(self._entregar(orden["id"], [{"linea": linea["id"], "cantidad": 9}]).status_code, 400)
        self.assertEqual(self._stock(self.filtro), 5)
        self.api.patch(f"{BASE}/{orden['id']}/lineas/{linea['id']}/", {"precio": "1"}, format="json")
        r = self._entregar(orden["id"], [{"linea": linea["id"], "cantidad": 1}])
        self.assertEqual(r.status_code, 400)
        self.assertIn("precio", r.json()["detail"])

    def test_no_cierra_con_pendientes(self):
        orden = self._orden_de_trabajo(bujia=2)
        r = self.api.post(f"{BASE}/{orden['id']}/cerrar/", {}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("despachar", r.json()["detail"])

    def test_prueba_pasa_a_orden_y_resto_vuelve(self):
        orden = self._orden_de_trabajo()
        r = self.api.post(f"{BASE}/{orden['id']}/pruebas/", {"producto": self.bujia.id, "cantidad": 3}, format="json")
        prueba = r.json()["pruebas"][0]
        self._entregar(orden["id"], [{"prueba": prueba["id"], "cantidad": 3}])
        self.assertEqual(self._stock(self.bujia), 7)
        data = self.api.post(
            f"{BASE}/{orden['id']}/pruebas/{prueba['id']}/pasar-a-orden/", {"cantidad": 1}, format="json"
        ).json()
        linea = next(l for l in data["lineas"] if l["producto"] == self.bujia.id)
        self.assertEqual((linea["cantidad"], linea["cantidad_despachada"]), (1, 1))
        self.assertEqual(self.api.post(f"{BASE}/{orden['id']}/cerrar/").status_code, 400)
        url = f"{BASE}/{orden['id']}/devoluciones/"
        r = self.api.post(url, {"prueba": prueba["id"], "cantidad": 2, "subdivision_id": self.sub2.id}, format="json")
        self.assertEqual(r.status_code, 403)
        self.assertEqual(self.admin_api.post(url, {"prueba": prueba["id"], "cantidad": 2}, format="json").status_code, 400)
        r = self.admin_api.post(
            url,
            {"prueba": prueba["id"], "cantidad": 2, "subdivision_id": self.sub2.id, "devuelto_por": "Wilmer"},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(self._stock(self.bujia), 9)
        self.assertEqual(self.api.post(f"{BASE}/{orden['id']}/cerrar/").status_code, 200)

    def test_ubicaciones_recomiendan_principal(self):
        orden = self._orden_de_trabajo(bujia=1)
        data = self.api.get(f"{BASE}/{orden['id']}/ubicaciones/?productos={self.bujia.id}").json()
        ubicaciones = data[str(self.bujia.id)]
        self.assertTrue(ubicaciones[0]["principal"])
        self.assertEqual(ubicaciones[0]["subdivision_id"], self.sub2.id)
        self.assertTrue(any(u["por_ubicar"] for u in ubicaciones))

    def test_admin_quita_despachado_y_se_devuelve(self):
        orden = self._orden_de_trabajo(bujia=4)
        linea = next(l for l in orden["lineas"] if l["tipo"] == "repuesto")
        self._entregar(orden["id"], [{"linea": linea["id"], "cantidad": 4}])
        data = self.admin_api.patch(f"{BASE}/{orden['id']}/lineas/{linea['id']}/", {"cantidad": 1}, format="json").json()
        quitado = next(p for p in data["pruebas"] if p["origen"] == "quitado")
        self.assertEqual(quitado["en_taller"], 3)
        self.assertEqual(self.admin_api.post(f"{BASE}/{orden['id']}/anular/").status_code, 400)
        r = self.admin_api.post(
            f"{BASE}/{orden['id']}/devoluciones/", {"prueba": quitado["id"], "subdivision_id": "por_ubicar"}, format="json"
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(self._stock(self.bujia), 9)

    def test_garantia_desde_orden_cerrada(self):
        orden = self._orden_de_trabajo(bujia=1)
        linea = next(l for l in orden["lineas"] if l["tipo"] == "repuesto")
        self._entregar(orden["id"], [{"linea": linea["id"], "cantidad": 1}])
        self.api.post(f"{BASE}/{orden['id']}/cerrar/", {"numero_factura": "F-77"}, format="json")

        encontradas = self.api.get(f"{BASE}/buscar-garantia/?q=F-77").json()
        self.assertEqual(encontradas[0]["id"], orden["id"])
        self.assertEqual(encontradas[0]["repuestos"][0]["producto"], self.bujia.id)

        garantia = self.api.post(f"{BASE}/", {"garantia_de": orden["id"]}, format="json").json()
        self.assertEqual(garantia["tipo"], "garantia")
        self.assertEqual(garantia["placa"], "PFI-8991")
        r = self.api.post(
            f"{BASE}/{garantia['id']}/lineas/",
            {"tipo": "repuesto", "producto": self.bujia.id, "es_garantia": True},
            format="json",
        )
        linea = r.json()["lineas"][0]
        self.assertEqual((linea["precio"], linea["precio_estado"], linea["es_garantia"]), ("0.00", "", True))
        normal = self.api.post(f"{BASE}/", {}, format="json").json()
        r = self.api.post(
            f"{BASE}/{normal['id']}/lineas/",
            {"tipo": "repuesto", "producto": self.bujia.id, "es_garantia": True},
            format="json",
        )
        self.assertEqual(r.status_code, 400)

    def test_sin_codigo_sugerencia_y_vinculo(self):
        from productos.models import OEM, OEMProducto

        oem = OEM.objects.create(codigo="1109.AY")
        OEMProducto.objects.create(producto=self.filtro, oem=oem)
        orden = self.api.post(f"{BASE}/", {}, format="json").json()
        r = self.api.post(
            f"{BASE}/{orden['id']}/lineas/",
            {"tipo": "sin_codigo", "referencia": "1109.AY", "descripcion": "Filtro aceite", "precio": "15"},
            format="json",
        )
        linea = r.json()["lineas"][0]
        self.api.post(f"{BASE}/{orden['id']}/aceptar/")
        avisos = self.admin_api.get(f"{BASE}/?alerta=sin_codigo").json()
        self.assertEqual(avisos["avisos"]["sin_codigo"], 1)

        sug = self.admin_api.get(f"{BASE}/sugerir-codigo/?referencia=1109.AY&casa={self.casa_px.id}").json()
        self.assertEqual(sug["codigo_sugerido"], "P1268PX")
        sug = self.admin_api.get(f"{BASE}/sugerir-codigo/?referencia=1109.AY&casa={self.casa_cl.id}").json()
        self.assertEqual(sug["existente"]["codigo"], "P1268CL")
        self.assertEqual(self.api.get(f"{BASE}/sugerir-codigo/?referencia=1109.AY").status_code, 403)

        nuevo = Producto.objects.create(codigo="P1268PX", nombre="Filtro PX", precio=Decimal("15"))
        data = self.admin_api.post(
            f"{BASE}/{orden['id']}/lineas/{linea['id']}/vincular-producto/", {"producto": nuevo.id}, format="json"
        ).json()
        linea = data["lineas"][0]
        self.assertEqual(
            (linea["tipo"], linea["producto"], linea["era_sin_codigo"], linea["precio"]),
            ("repuesto", nuevo.id, True, "15.00"),
        )

    def test_salida_taller_no_se_elimina(self):
        orden = self._orden_de_trabajo(bujia=1)
        linea = next(l for l in orden["lineas"] if l["tipo"] == "repuesto")
        self._entregar(orden["id"], [{"linea": linea["id"], "cantidad": 1}])
        self.api.post(f"{BASE}/{orden['id']}/cerrar/")
        from movimientos.models import MovimientoInventario

        salida = MovimientoInventario.objects.get(orden_taller__id=orden["id"])
        r = self.admin_api.delete(f"/movimientos/movimiento_inventario/{salida.id}/")
        self.assertEqual(r.status_code, 400)
        self.assertTrue(MovimientoInventario.objects.filter(pk=salida.id).exists())

    def test_despacho_desde_otra_sucursal_y_salida_por_sucursal(self):
        from inventario.models import Bodega, Division, Inventario, Sucursal, SubDivision
        from movimientos.models import MovimientoInventario
        from taller.models import Taller
        from tipos.models import TipoDivision

        taller = Taller.objects.get(sucursal=self.sucursal)
        norte = Sucursal.objects.create(nombre="Norte test", direccion="n")
        bodega = Bodega.objects.create(sucursal=norte, nombre="Almacen N")
        division = Division.objects.create(bodega=bodega, nombre="B", tipo_division=TipoDivision.objects.first())
        sub_norte = SubDivision.objects.create(division=division, nombre="1")
        Inventario.objects.create(producto=self.filtro, subdivision=sub_norte, cantidad=4)

        orden = self._orden_de_trabajo(filtro=7)
        self.assertEqual(orden["taller"], taller.id)
        linea = next(l for l in orden["lineas"] if l["tipo"] == "repuesto")
        # En 9 de Octubre solo hay 5: no alcanza y avisa que hay en Norte.
        r = self._entregar(orden["id"], [{"linea": linea["id"], "cantidad": 7}])
        self.assertEqual(r.status_code, 400)
        self.assertIn("Norte test", r.json()["detail"])
        # La busqueda muestra el stock de las otras sucursales.
        encontrados = self.api.get(f"{BASE}/buscar-productos/?q=P1268CL&sucursal={self.sucursal.id}").json()
        self.assertEqual((encontrados[0]["stock"], encontrados[0]["stock_otras"]), (5, 4))
        # 5 de aqui y 2 de Norte.
        self._entregar(orden["id"], [{"linea": linea["id"], "cantidad": 5}])
        r = self._entregar(orden["id"], [{"linea": linea["id"], "cantidad": 2, "subdivision_id": sub_norte.id}])
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(Inventario.objects.get(subdivision=sub_norte, producto=self.filtro).cantidad, 2)
        from taller.stock import en_taller_por_producto_sucursal

        en_taller = en_taller_por_producto_sucursal([self.filtro.id])
        self.assertEqual(en_taller[(self.filtro.id, norte.id)]["cantidad"], 2)
        self.assertEqual(en_taller[(self.filtro.id, self.sucursal.id)]["cantidad"], 5)

        self.assertEqual(self.api.post(f"{BASE}/{orden['id']}/cerrar/").status_code, 200)
        salidas = {m.sucursal_id: m for m in MovimientoInventario.objects.filter(ordenes_taller__id=orden["id"])}
        self.assertEqual(set(salidas), {self.sucursal.id, norte.id})
        self.assertEqual(salidas[norte.id].detalles.get().cantidad, 2)
        self.assertEqual(salidas[self.sucursal.id].detalles.get().cantidad, 5)

    def test_talleres_solo_admin(self):
        r = self.api.post("/taller/talleres/", {"nombre": "Taller Norte", "sucursal": self.sucursal.id}, format="json")
        self.assertEqual(r.status_code, 403)
        r = self.admin_api.post("/taller/talleres/", {"nombre": "Taller Norte", "sucursal": self.sucursal.id}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        orden = self.api.post(f"{BASE}/", {"taller": r.json()["id"]}, format="json").json()
        self.assertEqual(orden["taller_nombre"], "Taller Norte")
