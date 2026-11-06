from decimal import Decimal

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from usuarios.models import Rol, RolPermiso

from .models import Caja, CategoriaGasto

BASE = "/caja-chica"


class CajaChicaTests(TestCase):
    def setUp(self):
        User = get_user_model()
        self.admin = User.objects.create_superuser(username="adm@c.com", email="adm@c.com", password="x")
        self.custodio = User.objects.create_user(username="cus@c.com", email="cus@c.com", password="x")
        self.otro = User.objects.create_user(username="otro@c.com", email="otro@c.com", password="x")
        rol = Rol.objects.create(nombre="Caja")
        RolPermiso.objects.create(rol=rol, modulo="caja_chica", puede_leer=True, puede_crear=True, puede_actualizar=True, puede_eliminar=True)
        rol.usuarios.add(self.custodio, self.otro)
        self.admin_api = APIClient()
        self.admin_api.force_authenticate(self.admin)
        self.api = APIClient()
        self.api.force_authenticate(self.custodio)
        self.categoria = CategoriaGasto.objects.get(nombre="Movilización")
        r = self.admin_api.post(
            f"{BASE}/cajas/",
            {"nombre": "Caja Matriz", "monto_fondo": "300", "tope_gasto": "50", "custodio": self.custodio.id},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.caja = Caja.objects.get(pk=r.json()["id"])

    def _gasto(self, monto, client=None, **extra):
        data = {
            "caja": self.caja.id,
            "tipo": "gasto",
            "monto": monto,
            "categoria": self.categoria.id,
            "descripcion": "Taxi",
            "comprobante_tipo": "recibo",
            **extra,
        }
        return (client or self.api).post(f"{BASE}/movimientos/", data, format="json")

    def test_apertura_y_saldo(self):
        self.assertEqual(self.caja.saldo(), Decimal("300"))
        self.assertEqual(self._gasto("20").json()["estado"], "aprobado")
        self.assertEqual(self.caja.saldo(), Decimal("280"))

    def test_solo_el_custodio_ve_su_caja(self):
        otro = APIClient()
        otro.force_authenticate(self.otro)
        self.assertEqual(otro.get(f"{BASE}/cajas/").json(), [])
        self.assertEqual(self._gasto("5", client=otro).status_code, 400)

    def test_sobre_el_tope_espera_aprobacion(self):
        mov = self._gasto("80").json()
        self.assertEqual(mov["estado"], "pendiente")
        self.assertEqual(self.caja.saldo(), Decimal("300"))
        self.assertEqual(self.api.post(f"{BASE}/movimientos/{mov['id']}/aprobar/").status_code, 403)
        self.assertEqual(self.admin_api.post(f"{BASE}/movimientos/{mov['id']}/aprobar/").json()["estado"], "aprobado")
        self.assertEqual(self.caja.saldo(), Decimal("220"))

    def test_rechazado_se_corrige(self):
        mov = self._gasto("80").json()
        self.admin_api.post(f"{BASE}/movimientos/{mov['id']}/rechazar/", {"motivo": "Sin factura"}, format="json")
        r = self.api.patch(f"{BASE}/movimientos/{mov['id']}/", {"monto": "40"}, format="json")
        self.assertEqual(r.json()["estado"], "aprobado")

    def test_no_gasta_mas_del_saldo(self):
        r = self._gasto("400", client=self.admin_api)
        self.assertEqual(r.status_code, 400)

    def test_validaciones_de_gasto(self):
        self.assertEqual(self._gasto("10", categoria=None).status_code, 400)
        self.assertEqual(self._gasto("10", comprobante_tipo="").status_code, 400)
        self.assertEqual(self._gasto("0").status_code, 400)

    def test_anticipo_con_vuelto(self):
        r = self.api.post(
            f"{BASE}/movimientos/",
            {"caja": self.caja.id, "tipo": "anticipo", "monto": "40", "descripcion": "Comprar repuesto", "beneficiario": "Juan"},
            format="json",
        )
        anticipo = r.json()
        self.assertEqual(self.caja.saldo(), Decimal("260"))
        r = self.api.post(
            f"{BASE}/movimientos/{anticipo['id']}/liquidar/",
            {"monto_gastado": "32.50", "categoria": self.categoria.id, "comprobante_tipo": "factura", "comprobante_numero": "001"},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["liquidacion"]["gastado"], "32.50")
        self.assertEqual(self.caja.saldo(), Decimal("267.50"))
        resumen = self.api.get(f"{BASE}/cajas/{self.caja.id}/resumen/").json()
        self.assertEqual(resumen["total_gastos"], "32.50")

    def test_anticipo_que_se_paso(self):
        anticipo = self.api.post(
            f"{BASE}/movimientos/",
            {"caja": self.caja.id, "tipo": "anticipo", "monto": "20", "descripcion": "x", "beneficiario": "Juan"},
            format="json",
        ).json()
        self.api.post(
            f"{BASE}/movimientos/{anticipo['id']}/liquidar/",
            {"monto_gastado": "25", "categoria": self.categoria.id, "comprobante_tipo": "recibo"},
            format="json",
        )
        self.assertEqual(self.caja.saldo(), Decimal("275"))

    def test_arqueo_y_reposicion(self):
        self._gasto("30")
        r = self.api.post(f"{BASE}/cajas/{self.caja.id}/arqueos/", {"denominaciones": {"100": 2, "50": 1, "10": 1}}, format="json")
        self.assertEqual(r.status_code, 400)  # faltante sin explicar
        r = self.api.post(
            f"{BASE}/cajas/{self.caja.id}/arqueos/",
            {"denominaciones": {"100": 2, "50": 1, "10": 1}, "observacion": "Falta un recibo"},
            format="json",
        )
        self.assertEqual(r.json()["diferencia"], "-10.00")
        rep = self.api.post(f"{BASE}/cajas/{self.caja.id}/reposicion/", {}, format="json").json()
        self.assertEqual((rep["monto"], rep["estado"]), ("30.00", "pendiente"))
        self.assertEqual(self.api.post(f"{BASE}/cajas/{self.caja.id}/reposicion/", {}, format="json").status_code, 400)
        self.admin_api.post(f"{BASE}/movimientos/{rep['id']}/aprobar/")
        self.assertEqual(self.caja.saldo(), Decimal("300"))

    def test_solo_admin_configura(self):
        self.assertEqual(self.api.post(f"{BASE}/cajas/", {"nombre": "X", "monto_fondo": "10"}, format="json").status_code, 403)
        self.assertEqual(self.api.post(f"{BASE}/categorias/", {"nombre": "X"}, format="json").status_code, 403)
