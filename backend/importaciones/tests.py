from decimal import Decimal

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from casa_comercial.models import CasaComercial
from inventario.models import Sucursal
from productos.models import Producto

from .models import Importacion, ImportacionEnvio, ImportacionEnvioDetalle

BASE_URL = "/importaciones/importaciones"


class BorradorRecepcionEnvioTests(TestCase):
    def setUp(self):
        User = get_user_model()
        self.admin = User.objects.create_superuser(
            username="admin@test.com", email="admin@test.com", password="x"
        )
        self.client = APIClient()
        self.client.force_authenticate(self.admin)
        self.sucursal = Sucursal.objects.create(nombre="Norte", direccion="Av 1")
        casa = CasaComercial.objects.create(nombre="Casa", codigo="C1")
        importacion = Importacion.objects.create(codigo="IMP-1", casa_comercial=casa)
        self.producto = Producto.objects.create(codigo="P-1", nombre="Filtro", precio=Decimal("10"))
        self.envio = ImportacionEnvio.objects.create(importacion=importacion, sucursal=self.sucursal)
        ImportacionEnvioDetalle.objects.create(envio=self.envio, producto=self.producto, cantidad=5)

    def _url(self, envio_id=None):
        return f"{BASE_URL}/envios/{envio_id or self.envio.id}/borrador-recepcion/"

    def test_guarda_y_devuelve_borrador_en_envios_pendientes(self):
        response = self.client.patch(
            self._url(),
            {
                "items": {
                    str(self.producto.id): {
                        "cantidad_recibida": 4,
                        "recepcion_revisada": True,
                        "novedad": " falta uno ",
                        "ubicaciones": [
                            {"subdivision_id": 7, "cantidad": 4},
                            {"subdivision_id": None, "cantidad": 1},
                        ],
                    }
                }
            },
            format="json",
        )
        self.assertEqual(response.status_code, 200)

        listado = self.client.get(f"{BASE_URL}/envios-pendientes/")
        self.assertEqual(listado.status_code, 200)
        row = next(r for r in listado.json() if r["envio_id"] == self.envio.id)
        self.assertEqual(
            row["borrador_recepcion"],
            {
                str(self.producto.id): {
                    "cantidad_recibida": 4,
                    "recepcion_revisada": True,
                    "novedad": "falta uno",
                    "ubicaciones": [{"subdivision_id": 7, "cantidad": 4}],
                }
            },
        )

    def test_guarda_nota_general(self):
        response = self.client.patch(
            self._url(),
            {
                "items": {str(self.producto.id): {"cantidad_recibida": 5, "recepcion_revisada": True}},
                "tiene_novedad_general": True,
                "nota_general": "Caja golpeada",
            },
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        self.envio.refresh_from_db()
        self.assertEqual(
            self.envio.borrador_recepcion["__meta__"],
            {"tiene_novedad_general": True, "nota_general": "Caja golpeada"},
        )
        self.assertTrue(self.envio.borrador_recepcion[str(self.producto.id)]["recepcion_revisada"])

    def test_envio_recibido_no_acepta_borrador(self):
        ImportacionEnvio.objects.filter(pk=self.envio.pk).update(estado=ImportacionEnvio.ESTADO_RECIBIDO)
        response = self.client.patch(self._url(), {"items": {}}, format="json")
        self.assertEqual(response.status_code, 404)

    def test_items_invalidos(self):
        response = self.client.patch(self._url(), {"items": []}, format="json")
        self.assertEqual(response.status_code, 400)

    def test_usuario_sin_acceso_a_la_sucursal(self):
        otro = get_user_model().objects.create_user(
            username="otro@test.com", email="otro@test.com", password="x"
        )
        client = APIClient()
        client.force_authenticate(otro)
        response = client.patch(self._url(), {"items": {}}, format="json")
        self.assertIn(response.status_code, (403, 404))
        self.envio.refresh_from_db()
        self.assertEqual(self.envio.borrador_recepcion, {})


class SugerenciaProductosNuevosTests(TestCase):
    """En la sugerencia (borrador) los productos nuevos no entran al catalogo
    ni se exige cantidad; al pedir la cotizacion se exige la cantidad. Los
    productos nuevos se crean con su PVP aprox. recien al importar, y solo
    los que si se importan."""

    def setUp(self):
        User = get_user_model()
        self.admin = User.objects.create_superuser(
            username="admin-sug@test.com", email="admin-sug@test.com", password="x"
        )
        self.client = APIClient()
        self.client.force_authenticate(self.admin)
        self.casa = CasaComercial.objects.create(
            nombre="Casa Imp", codigo="CI", tipo=CasaComercial.TIPO_IMPORTACION
        )
        self.existente = Producto.objects.create(codigo="EX-1", nombre="Faro", precio=Decimal("20"))

    def _crear(self, cantidad_nuevo=0):
        response = self.client.post(
            f"{BASE_URL}/",
            {
                "casa_comercial_id": self.casa.id,
                "detalles": [
                    {"producto_id": self.existente.id, "cantidad": 0, "precio_estimado": "18.50"},
                    {
                        "codigo": "NUEVO-CI", "nombre": "Filtro nuevo", "referencia": "REF-NUEVO",
                        "oem": "OEM-NUEVO", "cantidad": cantidad_nuevo, "precio_estimado": "12.30",
                    },
                ],
            },
            format="json",
        )
        self.assertEqual(response.status_code, 201, response.data)
        return Importacion.objects.get(pk=response.data["id"])

    def test_en_sugerencia_no_se_crea_el_producto_ni_se_exige_cantidad(self):
        importacion = self._crear()
        self.assertFalse(Producto.objects.filter(codigo="NUEVO-CI").exists())
        detalle = importacion.detalles.get(codigo="NUEVO-CI")
        self.assertIsNone(detalle.producto_id)
        self.assertEqual(detalle.precio_estimado, Decimal("12.30"))
        self.assertEqual(importacion.detalles.get(producto=self.existente).precio_estimado, Decimal("18.50"))

    def test_coincidencia_se_guarda_y_se_conserva_al_guardar(self):
        """El amarillo/naranja de la vista previa queda en la sugerencia solo
        como referencia (no crea el producto) y un guardado que no la manda
        no la borra."""
        response = self.client.post(
            f"{BASE_URL}/",
            {
                "casa_comercial_id": self.casa.id,
                "detalles": [{
                    "codigo": "SUG-CI", "nombre": "Copela", "oem": "516533", "cantidad": 0,
                    "coincidencia": "oem", "coincidencia_codigo": "C0583CL",
                    "coincidencia_casa": "Otra", "coincidencia_precio": "30.00",
                }],
            },
            format="json",
        )
        self.assertEqual(response.status_code, 201, response.data)
        importacion = Importacion.objects.get(pk=response.data["id"])
        self.assertFalse(Producto.objects.filter(codigo="SUG-CI").exists())

        response = self.client.patch(
            f"{BASE_URL}/{importacion.id}/",
            {"detalles": [{"codigo": "SUG-CI", "nombre": "Copela", "cantidad": 2}]},
            format="json",
        )
        self.assertEqual(response.status_code, 200, response.data)
        detalle = importacion.detalles.get(codigo="SUG-CI")
        self.assertEqual(detalle.coincidencia, "oem")
        self.assertEqual(detalle.coincidencia_codigo, "C0583CL")
        self.assertEqual(detalle.coincidencia_casa, "Otra")
        self.assertEqual(detalle.coincidencia_precio, Decimal("30.00"))

    def test_pedir_cotizacion_permite_cantidad_cero(self):
        """La cantidad se completa en la verificacion (Cant. aprox.)."""
        importacion = self._crear()
        response = self.client.post(f"{BASE_URL}/{importacion.id}/pedir-cotizacion/")
        self.assertEqual(response.status_code, 200, response.data)
        importacion.refresh_from_db()
        self.assertEqual(importacion.estado, Importacion.ESTADO_COTIZACION)
        self.assertFalse(Producto.objects.filter(codigo="NUEVO-CI").exists())

    def test_sugerencia_incompleta_se_crea_pero_no_pasa_a_cotizacion(self):
        """Un producto sin catalogo al que le falta codigo, referencia o
        descripcion no impide crear la sugerencia, solo pedir la cotizacion;
        completado, ya se puede (con cantidad 0). El OEM no es obligatorio:
        hay casas cuyos productos no tienen OEM."""
        response = self.client.post(
            f"{BASE_URL}/",
            {
                "casa_comercial_id": self.casa.id,
                "detalles": [
                    {"producto_id": self.existente.id, "cantidad": 0},
                    {"codigo": "INC-1", "nombre": "Sin referencia ni OEM", "cantidad": 0},
                    {"codigo": "", "nombre": "", "referencia": "REF-INC-2", "oem": "OEM-INC-2", "cantidad": 0},
                ],
            },
            format="json",
        )
        self.assertEqual(response.status_code, 201, response.data)
        importacion = Importacion.objects.get(pk=response.data["id"])

        response = self.client.post(f"{BASE_URL}/{importacion.id}/pedir-cotizacion/")
        self.assertEqual(response.status_code, 400)
        for falta in ("1 sin código", "1 sin referencia", "1 sin descripción"):
            self.assertIn(falta, response.data["detail"])
        self.assertNotIn("OEM", response.data["detail"])
        importacion.refresh_from_db()
        self.assertEqual(importacion.estado, Importacion.ESTADO_BORRADOR)

        # Sin OEM, pero con referencia: ya puede pasar a cotizacion.
        importacion.detalles.filter(codigo="INC-1").update(referencia="REF-INC-1")
        importacion.detalles.filter(referencia="REF-INC-2").update(codigo="INC-2", nombre="Ya completo")
        response = self.client.post(f"{BASE_URL}/{importacion.id}/pedir-cotizacion/")
        self.assertEqual(response.status_code, 200, response.data)

    def _pedir_cotizacion(self, importacion):
        importacion.detalles.filter(producto=self.existente).update(cantidad=2)
        response = self.client.post(f"{BASE_URL}/{importacion.id}/pedir-cotizacion/")
        self.assertEqual(response.status_code, 200, response.data)

    def _importar(self, importacion, seleccionados):
        response = self.client.post(
            f"{BASE_URL}/{importacion.id}/importar/",
            {"numero_factura": "F-1", "detalles_seleccionados": seleccionados},
            format="json",
        )
        self.assertEqual(response.status_code, 200, response.data)

    def test_pedir_cotizacion_no_crea_los_productos_nuevos(self):
        importacion = self._crear(cantidad_nuevo=3)
        self._pedir_cotizacion(importacion)
        self.assertFalse(Producto.objects.filter(codigo="NUEVO-CI").exists())
        self.assertIsNone(importacion.detalles.get(codigo="NUEVO-CI").producto_id)

    def test_guardar_en_verificacion_no_crea_productos(self):
        importacion = self._crear(cantidad_nuevo=3)
        self._pedir_cotizacion(importacion)
        response = self.client.patch(
            f"{BASE_URL}/{importacion.id}/",
            {
                "detalles": [
                    {"producto_id": self.existente.id, "cantidad": 2},
                    {"codigo": "NUEVO-CI", "nombre": "Filtro nuevo", "cantidad": 3},
                    {"codigo": "ex-1", "nombre": "Faro", "cantidad": 1},
                ],
            },
            format="json",
        )
        self.assertEqual(response.status_code, 200, response.data)
        self.assertFalse(Producto.objects.filter(codigo="NUEVO-CI").exists())
        # Un código nuevo que ya existe en el catálogo no se vincula solo: al
        # pedir la confirmación se avisa para cambiarlo.
        self.assertIsNone(importacion.detalles.get(codigo="ex-1").producto_id)
        response = self.client.post(f"{BASE_URL}/{importacion.id}/confirmar/")
        self.assertEqual(response.status_code, 400)
        self.assertEqual([row["codigo"] for row in response.data["codigos_invalidos"]], ["ex-1"])
        self.assertIn("ya existe en el catálogo (Faro)", response.data["codigos_invalidos"][0]["motivo"])
        importacion.refresh_from_db()
        self.assertEqual(importacion.estado, Importacion.ESTADO_COTIZACION)

    def test_confirmar_avisa_todos_los_codigos_nuevos_con_problema(self):
        importacion = self._crear(cantidad_nuevo=3)
        self._pedir_cotizacion(importacion)
        importacion.detalles.create(codigo="nuevo-ci", nombre="Otro", referencia="R2", cantidad=1)
        importacion.detalles.create(codigo="X" * 81, nombre="Largo", referencia="R3", cantidad=1)
        # Los quitados no se revisan: no se van a crear.
        importacion.detalles.create(codigo="EX-1", nombre="Faro", referencia="R4", cantidad=1, quitado=True)
        response = self.client.post(f"{BASE_URL}/{importacion.id}/confirmar/")
        self.assertEqual(response.status_code, 400)
        motivos = {row["codigo"]: row["motivo"] for row in response.data["codigos_invalidos"]}
        self.assertEqual(set(motivos), {"NUEVO-CI", "X" * 81})
        self.assertIn("repetido 2 veces", motivos["NUEVO-CI"])
        self.assertIn("más de 80 caracteres", motivos["X" * 81])
        self.assertFalse(Producto.objects.filter(codigo__iexact="NUEVO-CI").exists())

    def test_confirmar_guarda_los_quitados_que_manda_el_guardado(self):
        """El guardado previo a confirmar manda los quitados con su marca, así
        llegan al historial antes de sacarlos."""
        importacion = self._crear(cantidad_nuevo=3)
        self._pedir_cotizacion(importacion)
        response = self.client.patch(
            f"{BASE_URL}/{importacion.id}/",
            {
                "detalles": [
                    {"producto_id": self.existente.id, "cantidad": 2},
                    {"codigo": "NUEVO-CI", "nombre": "Filtro nuevo", "cantidad": 0, "quitado": True},
                ],
            },
            format="json",
        )
        self.assertEqual(response.status_code, 200, response.data)
        response = self.client.post(f"{BASE_URL}/{importacion.id}/confirmar/")
        self.assertEqual(response.status_code, 200, response.data)
        importacion.refresh_from_db()
        estados = {row["codigo"]: row["estado"] for row in importacion.historial_verificacion}
        self.assertEqual(estados, {"EX-1": "pedido", "NUEVO-CI": "quitado"})

    def test_guardar_sin_precio_casa_conserva_la_casa_del_precio(self):
        importacion = self._crear(cantidad_nuevo=3)
        importacion.detalles.filter(codigo="NUEVO-CI").update(precio_casa="TECNOVA")
        response = self.client.patch(
            f"{BASE_URL}/{importacion.id}/",
            {
                "detalles": [
                    {"producto_id": self.existente.id, "cantidad": 2},
                    {"codigo": "NUEVO-CI", "nombre": "Filtro nuevo", "cantidad": 3, "precio_estimado": "12.30"},
                ],
            },
            format="json",
        )
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(importacion.detalles.get(codigo="NUEVO-CI").precio_casa, "TECNOVA")

    def test_confirmar_guarda_que_se_pidio_y_que_no(self):
        importacion = self._crear(cantidad_nuevo=3)
        self._pedir_cotizacion(importacion)
        importacion.detalles.filter(codigo="NUEVO-CI").update(quitado=True)
        response = self.client.post(f"{BASE_URL}/{importacion.id}/confirmar/")
        self.assertEqual(response.status_code, 200, response.data)
        importacion.refresh_from_db()
        estados = {row["codigo"]: row["estado"] for row in importacion.historial_verificacion}
        self.assertEqual(estados, {"EX-1": "pedido", "NUEVO-CI": "quitado"})
        self.assertFalse(importacion.detalles.filter(codigo="NUEVO-CI").exists())

    def test_importar_no_crea_los_productos_negados(self):
        importacion = self._crear(cantidad_nuevo=3)
        self._pedir_cotizacion(importacion)
        self._importar(importacion, [str(self.existente.id)])
        self.assertFalse(Producto.objects.filter(codigo="NUEVO-CI").exists())

    def test_importar_crea_solo_los_productos_nuevos_importados(self):
        importacion = self._crear(cantidad_nuevo=3)
        self._pedir_cotizacion(importacion)
        detalle_nuevo = importacion.detalles.get(codigo="NUEVO-CI")
        self._importar(importacion, [f"sc_{detalle_nuevo.id}"])
        producto = Producto.objects.get(codigo="NUEVO-CI")
        self.assertEqual(producto.precio, Decimal("12.30"))
        self.assertEqual(producto.creado_desde_importacion_id, importacion.id)
        self.assertTrue(producto.casas_comerciales.filter(pk=self.casa.pk).exists())
        self.assertEqual(importacion.detalles.get(codigo="NUEVO-CI").producto_id, producto.id)

    def test_importar_no_crea_ninguno_si_un_codigo_ya_existe(self):
        importacion = self._crear(cantidad_nuevo=3)
        self._pedir_cotizacion(importacion)
        otro = importacion.detalles.create(codigo="OTRO-CI", nombre="Otro", referencia="R2", cantidad=1)
        detalle_nuevo = importacion.detalles.get(codigo="NUEVO-CI")
        # Alguien crea ese código en el catálogo mientras tanto.
        Producto.objects.create(codigo="NUEVO-CI", nombre="Creado aparte", precio=Decimal("5"))
        seleccionados = [f"sc_{detalle_nuevo.id}", f"sc_{otro.id}"]
        response = self.client.post(
            f"{BASE_URL}/{importacion.id}/importar/",
            {"numero_factura": "F-1", "detalles_seleccionados": seleccionados},
            format="json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual([row["codigo"] for row in response.data["codigos_invalidos"]], ["NUEVO-CI"])
        self.assertFalse(Producto.objects.filter(codigo="OTRO-CI").exists())
        importacion.refresh_from_db()
        self.assertEqual(importacion.numero_factura, "")
        self.assertEqual(importacion.detalles.count(), 3)

        # Corregido en la confirmación, se importa con el código nuevo.
        response = self.client.post(
            f"{BASE_URL}/{importacion.id}/importar/",
            {
                "numero_factura": "F-1",
                "detalles_seleccionados": seleccionados,
                "detalles": [{"detalle_id": detalle_nuevo.id, "codigo": "NUEVO-CI-2"}],
            },
            format="json",
        )
        self.assertEqual(response.status_code, 200, response.data)
        self.assertTrue(Producto.objects.filter(codigo="NUEVO-CI-2").exists())
        self.assertTrue(Producto.objects.filter(codigo="OTRO-CI").exists())


class ExcelRecomendacionesPorReferenciaTests(TestCase):
    """Las recomendaciones del Excel salen tanto de la columna OEM como de la
    columna Referencia, comparando contra los OEM y las referencias del
    catalogo (un producto puede tener la referencia guardada y no el OEM)."""

    def setUp(self):
        from productos.models import OEM, OEMProducto, ProductoReferencia

        self.amerigo = CasaComercial.objects.create(nombre="AMERIGO", codigo="AM", tipo=CasaComercial.TIPO_IMPORTACION)
        tecnova = CasaComercial.objects.create(nombre="TECNOVA", codigo="CL")
        # Solo referencia guardada (sin OEM).
        self.solo_ref = Producto.objects.create(codigo="C0513CL", nombre="Soporte", precio=Decimal("60"))
        self.solo_ref.casas_comerciales.add(tecnova)
        ProductoReferencia.objects.create(producto=self.solo_ref, valor="513A9")
        # Solo OEM guardado (sin esa referencia).
        self.solo_oem = Producto.objects.create(codigo="C0583CL", nombre="Copela", precio=Decimal("30"))
        self.solo_oem.casas_comerciales.add(tecnova)
        OEMProducto.objects.create(producto=self.solo_oem, oem=OEM.objects.create(codigo="516533"))

    def _parse(self, headers, rows):
        import io
        from unittest import mock

        import openpyxl

        from .models import ImportacionExcelJob
        from .viewsets import _run_parse_excel_job

        wb = openpyxl.Workbook()
        ws = wb.active
        ws.append(headers)
        for row in rows:
            ws.append(row)
        buffer = io.BytesIO()
        wb.save(buffer)
        job = ImportacionExcelJob.objects.create()
        # El job cierra las conexiones al terminar (corre en un thread); en la
        # prueba eso romperia la transaccion.
        with mock.patch("importaciones.viewsets.connections"):
            _run_parse_excel_job(job.id, buffer.getvalue(), self.amerigo.id)
        job.refresh_from_db()
        self.assertEqual(job.estado, ImportacionExcelJob.ESTADO_LISTO, job.error)
        return {row["referencia"] or row["oem"]: row for row in job.resultado["rows"]}

    def test_solo_referencia_recomienda_por_referencia_y_por_oem(self):
        rows = self._parse(["REFERENCIA", "PVP"], [["513A9", 40], ["516533", 15]])
        self.assertEqual([m["codigo"] for m in rows["513A9"]["oem_matches"]], ["C0513CL"])
        self.assertEqual([m["codigo"] for m in rows["516533"]["oem_matches"]], ["C0583CL"])
        match = rows["516533"]["oem_matches"][0]
        self.assertEqual(match["oems"], ["516533"])
        self.assertEqual(match["precio"], 30.0)

    def test_solo_oem_tambien_encuentra_la_referencia(self):
        rows = self._parse(["OEM"], [["513A9"]])
        self.assertEqual([m["codigo"] for m in rows["513A9"]["oem_matches"]], ["C0513CL"])
        self.assertEqual(rows["513A9"]["oem_matches"][0]["referencias"], ["513A9"])
