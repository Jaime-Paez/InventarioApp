from decimal import Decimal

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from productos.models import OEM, OEMProducto, Producto, ProductoAlterno

BASE = "/productos/listado"


class AlternosGrupoTests(TestCase):
    """Vincular el grupo (todos con todos + OEM compartidos) y sacar un alterno
    del grupo completo quitandole solo a el los OEM confirmados."""

    def setUp(self):
        admin = get_user_model().objects.create_superuser(
            username="admin@test.com", email="admin@test.com", password="x"
        )
        self.client = APIClient()
        self.client.force_authenticate(admin)
        self.a, self.b, self.c = (
            Producto.objects.create(codigo=f"A0023{s}", nombre="AMORTIGUADOR", precio=Decimal("1"))
            for s in ("SL", "QH", "CL")
        )
        self.oem = OEM.objects.create(codigo="8731E6")
        OEMProducto.objects.create(producto=self.a, oem=self.oem)

    def _vincular(self):
        res = self.client.post(f"{BASE}/{self.a.id}/vincular-grupo/", {"ids": [self.b.id, self.c.id]}, format="json")
        self.assertEqual(res.status_code, 200)

    def test_grupo_sugerido_y_vincular_todos_con_todos(self):
        res = self.client.get(f"{BASE}/{self.a.id}/grupo-sugerido/")
        self.assertEqual(res.data["base"], "A0023")
        self.assertEqual({p["codigo"] for p in res.data["productos"]}, {"A0023QH", "A0023CL"})

        self._vincular()
        self.assertEqual(ProductoAlterno.objects.count(), 6)
        self.assertTrue(ProductoAlterno.objects.filter(producto=self.b, alterno=self.c).exists())
        for p in (self.a, self.b, self.c):
            self.assertTrue(OEMProducto.objects.filter(producto=p, oem=self.oem).exists())

    def test_quitar_alterno_sale_del_grupo_y_pierde_solo_su_oem(self):
        self._vincular()
        prev = self.client.get(f"{BASE}/{self.a.id}/quitar-alterno-preview/", {"alterno_id": self.b.id})
        self.assertEqual(prev.status_code, 200)
        self.assertEqual(set(prev.data["grupo"]), {"A0023SL", "A0023CL"})
        self.assertEqual([o["codigo"] for o in prev.data["oems"]], ["8731E6"])

        res = self.client.post(
            f"{BASE}/{self.a.id}/quitar-alterno/", {"alterno_id": self.b.id, "oem_ids": [self.oem.id]}, format="json"
        )
        self.assertEqual(res.status_code, 200)
        self.assertFalse(ProductoAlterno.objects.filter(producto=self.b).exists())
        self.assertFalse(ProductoAlterno.objects.filter(alterno=self.b).exists())
        self.assertTrue(ProductoAlterno.objects.filter(producto=self.a, alterno=self.c).exists())
        self.assertFalse(OEMProducto.objects.filter(producto=self.b).exists())
        self.assertTrue(OEMProducto.objects.filter(producto=self.a, oem=self.oem).exists())
        self.assertTrue(OEMProducto.objects.filter(producto=self.c, oem=self.oem).exists())

    def test_quitar_alterno_sin_marcar_oem_lo_conserva(self):
        self._vincular()
        self.client.post(f"{BASE}/{self.a.id}/quitar-alterno/", {"alterno_id": self.b.id, "oem_ids": []}, format="json")
        self.assertTrue(OEMProducto.objects.filter(producto=self.b, oem=self.oem).exists())
        self.assertFalse(ProductoAlterno.objects.filter(alterno=self.b).exists())
