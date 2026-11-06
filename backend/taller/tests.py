from decimal import Decimal

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from productos.models import Producto
from usuarios.models import Rol

from .models import ManoObra, OrdenTaller, OrdenTallerLinea

BASE = "/taller/ordenes"


class OrdenTallerTests(TestCase):
    def setUp(self):
        User = get_user_model()
        self.admin = User.objects.create_superuser(username="admin@t.com", email="admin@t.com", password="x")
        self.asistente = User.objects.create_user(username="asis@t.com", email="asis@t.com", password="x")
        # El rol lo crea la migracion de datos de taller.
        Rol.objects.get(nombre="Asistente de servicio").usuarios.add(self.asistente)
        self.otro = User.objects.create_user(username="otro@t.com", email="otro@t.com", password="x")

        self.api = APIClient()
        self.api.force_authenticate(self.asistente)
        self.admin_api = APIClient()
        self.admin_api.force_authenticate(self.admin)

        self.filtro = Producto.objects.create(codigo="P1268", nombre="Filtro de aceite", precio=Decimal("12.50"))
        self.bujia = Producto.objects.create(codigo="C0104", nombre="Bujía", precio=Decimal("8.00"))
        self.trabajo = ManoObra.objects.create(nombre="Cambio de aceite", precio=Decimal("15.00"))

    def _crear(self, **data):
        response = self.api.post(f"{BASE}/", data, format="json")
        self.assertEqual(response.status_code, 201, response.content)
        return response.json()

    def _linea(self, orden_id, client=None, **data):
        return (client or self.api).post(f"{BASE}/{orden_id}/lineas/", data, format="json")

    def test_sin_permiso_de_taller_no_entra(self):
        client = APIClient()
        client.force_authenticate(self.otro)
        self.assertEqual(client.get(f"{BASE}/").status_code, 403)

    def test_numera_y_guarda_cabecera(self):
        a = self._crear(placa=" pfi-8991 ", numero_pedido="7969", modelo="3008 1.6 Turbo")
        b = self._crear()
        self.assertEqual(b["numero"], a["numero"] + 1)
        self.assertEqual(a["placa"], "PFI-8991")
        self.assertEqual(a["numero_pedido"], "7969")
        self.assertEqual(a["estado"], "cotizacion")

    def test_lineas_de_todos_los_tipos_y_total(self):
        orden = self._crear()
        self.assertEqual(self._linea(orden["id"], tipo="repuesto", producto=self.filtro.id, cantidad=2).status_code, 201)
        self._linea(orden["id"], tipo="mano_obra", mano_obra=self.trabajo.id)
        self._linea(orden["id"], tipo="insumo", descripcion="Cinta adhesiva", precio="1.25")
        response = self._linea(orden["id"], tipo="sin_codigo", referencia="9806", descripcion="Sensor", precio="40")
        data = response.json()
        self.assertEqual(len(data["lineas"]), 4)
        repuesto = data["lineas"][0]
        self.assertEqual(repuesto["precio"], "12.50")
        self.assertEqual(repuesto["precio_estado"], "")
        self.assertEqual(data["lineas"][1]["precio"], "15.00")
        listado = self.api.get(f"{BASE}/").json()
        fila = next(r for r in listado["results"] if r["id"] == orden["id"])
        self.assertEqual(fila["total"], "81.25")

    def test_mismo_repuesto_se_suma(self):
        orden = self._crear()
        self._linea(orden["id"], tipo="repuesto", producto=self.bujia.id, cantidad=2)
        data = self._linea(orden["id"], tipo="repuesto", producto=self.bujia.id, cantidad=2).json()
        self.assertEqual(len(data["lineas"]), 1)
        self.assertEqual(data["lineas"][0]["cantidad"], 4)

    def test_precio_distinto_al_pvp_queda_por_aprobar(self):
        orden = self._crear()
        data = self._linea(orden["id"], tipo="repuesto", producto=self.filtro.id, precio="10").json()
        linea = data["lineas"][0]
        self.assertEqual(linea["precio_estado"], "pendiente")

        url = f"{BASE}/{orden['id']}/lineas/{linea['id']}/revisar-precio/"
        self.assertEqual(self.api.post(url, {"aprobar": True}, format="json").status_code, 403)
        data = self.admin_api.post(url, {"aprobar": False}, format="json").json()
        self.assertEqual(data["lineas"][0]["precio"], "12.50")
        self.assertEqual(data["lineas"][0]["precio_estado"], "")

        # Volver al PVP no necesita aprobacion; el admin que cambia el precio lo deja aprobado.
        data = self.api.patch(f"{BASE}/{orden['id']}/lineas/{linea['id']}/", {"precio": "11"}, format="json").json()
        self.assertEqual(data["lineas"][0]["precio_estado"], "pendiente")
        data = self.admin_api.patch(f"{BASE}/{orden['id']}/lineas/{linea['id']}/", {"precio": "10"}, format="json").json()
        self.assertEqual(data["lineas"][0]["precio_estado"], "aprobado")

    def test_orden_de_trabajo_solo_agrega(self):
        orden = self._crear()
        data = self._linea(orden["id"], tipo="repuesto", producto=self.bujia.id, cantidad=4).json()
        linea_id = data["lineas"][0]["id"]
        self.assertEqual(self.api.post(f"{BASE}/{orden['id']}/aceptar/").status_code, 200)

        url = f"{BASE}/{orden['id']}/lineas/{linea_id}/"
        self.assertEqual(self.api.patch(url, {"cantidad": 3}, format="json").status_code, 403)
        self.assertEqual(self.api.delete(url).status_code, 403)
        self.assertEqual(self.api.patch(url, {"cantidad": 6}, format="json").status_code, 200)
        data = self._linea(orden["id"], tipo="insumo", descripcion="Goma").json()
        self.assertTrue(data["lineas"][-1]["agregada_en_orden"])

        # El administrador si puede corregir.
        self.assertEqual(self.admin_api.patch(url, {"cantidad": 2}, format="json").status_code, 200)
        self.assertEqual(self.admin_api.delete(url).status_code, 200)
        tipos = [e["tipo"] for e in self.api.get(f"{BASE}/{orden['id']}/").json()["eventos"]]
        self.assertIn("linea_quitada", tipos)
        self.assertIn("aceptada", tipos)

    def test_no_acepta_cotizacion_vacia_y_descarta(self):
        orden = self._crear()
        self.assertEqual(self.api.post(f"{BASE}/{orden['id']}/aceptar/").status_code, 400)
        self.assertEqual(self.api.delete(f"{BASE}/{orden['id']}/").status_code, 204)
        self.assertFalse(OrdenTaller.objects.filter(pk=orden["id"]).exists())

    def test_rechazar_reabrir_y_anular(self):
        orden = self._crear()
        self._linea(orden["id"], tipo="insumo", descripcion="Goma")
        data = self.api.post(f"{BASE}/{orden['id']}/rechazar/", {"motivo": "Caro"}, format="json").json()
        self.assertEqual(data["estado"], "rechazada")
        self.assertEqual(self.api.patch(f"{BASE}/{orden['id']}/", {"placa": "X"}, format="json").status_code, 400)
        self.assertEqual(self.api.post(f"{BASE}/{orden['id']}/reabrir/").json()["estado"], "cotizacion")
        self.assertEqual(self.api.post(f"{BASE}/{orden['id']}/anular/").status_code, 403)
        self.assertEqual(self.admin_api.post(f"{BASE}/{orden['id']}/anular/").json()["estado"], "anulada")

    def test_busca_por_placa_y_numero(self):
        a = self._crear(placa="PFI-8991")
        self._crear(placa="ABC-1234")
        results = self.api.get(f"{BASE}/?search=pfi").json()["results"]
        self.assertEqual([r["id"] for r in results], [a["id"]])
        results = self.api.get(f"{BASE}/?search=%23{a['numero']}").json()["results"]
        self.assertIn(a["id"], [r["id"] for r in results])

    def test_filtro_precios_pendientes_no_duplica_totales(self):
        orden = self._crear()
        self._linea(orden["id"], tipo="repuesto", producto=self.filtro.id, precio="10")
        self._linea(orden["id"], tipo="repuesto", producto=self.bujia.id, precio="5")
        results = self.api.get(f"{BASE}/?precios_pendientes=1").json()["results"]
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["total"], "15.00")
        self.assertEqual(results[0]["precios_pendientes"], 2)

    def test_buscar_productos(self):
        data = self.api.get(f"{BASE}/buscar-productos/?q=p1268").json()
        self.assertEqual(data[0]["codigo"], "P1268")
        self.assertEqual(data[0]["stock"], 0)

    def test_mano_obra_usada_se_desactiva(self):
        orden = self._crear()
        self._linea(orden["id"], tipo="mano_obra", mano_obra=self.trabajo.id)
        response = self.api.delete(f"/taller/mano-obra/{self.trabajo.id}/")
        self.assertEqual(response.status_code, 200)
        self.trabajo.refresh_from_db()
        self.assertFalse(self.trabajo.activo)
        self.assertTrue(OrdenTallerLinea.objects.filter(mano_obra=self.trabajo).exists())
