from decimal import Decimal

from django.test import SimpleTestCase

from movimientos.serializers import DetalleMovimientoSerializer


class RedondeoMontosDetalleTests(SimpleTestCase):
    """cantidad x valor en el navegador deja decimales flotantes
    (3 x 0.1 = 0.30000000000000004) y antes se rechazaba la salida con
    "Asegurese de que no haya mas de 12 digitos en total"."""

    def _validar(self, **data):
        serializer = DetalleMovimientoSerializer(data=data, partial=True)
        self.assertTrue(serializer.is_valid(), serializer.errors)
        return serializer.validated_data

    def test_redondea_el_total_flotante_a_centavos(self):
        datos = self._validar(valor_total=3 * 0.1, valor=0.1)
        self.assertEqual(datos["valor_total"], Decimal("0.30"))
        self.assertEqual(datos["valor"], Decimal("0.10"))

    def test_redondea_hacia_arriba_el_medio_centavo(self):
        datos = self._validar(valor_total=7 * 1.15, costo="2.345")
        self.assertEqual(datos["valor_total"], Decimal("8.05"))
        self.assertEqual(datos["costo"], Decimal("2.35"))

    def test_un_texto_que_no_es_numero_sigue_dando_error(self):
        serializer = DetalleMovimientoSerializer(data={"valor": "abc"}, partial=True)
        self.assertFalse(serializer.is_valid())
        self.assertIn("valor", serializer.errors)
