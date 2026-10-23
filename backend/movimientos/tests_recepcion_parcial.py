"""Recepcion por partes con ubicacion temporal POR UBICAR y unidades en camino."""

from decimal import Decimal

from django.contrib.auth import get_user_model
from django.db.models import Sum
from rest_framework.test import APITestCase

from importaciones.models import Importacion, ImportacionEnvio, ImportacionEnvioDetalle
from inventario.models import Bodega, Division, Inventario, SubDivision, Sucursal
from inventario.por_ubicar import POR_UBICAR_NOMBRE, in_transit_by_product_branch
from productos.models import Producto
from tipos.models import EstadoMovimiento, EstadoProducto, SubTipoMovimiento, TipoDivision, TipoMovimiento

from .models import DetalleMovimiento, MovimientoInventario, SolicitudTraslado, SolicitudTrasladoDetalle

BASE = "/movimientos/movimiento_inventario/solicitudes-traslado"


class RecepcionParcialTrasladoTests(APITestCase):
    def setUp(self):
        User = get_user_model()
        self.admin = User.objects.create_superuser(
            username="admin-rp@test.com", email="admin-rp@test.com", password="x"
        )
        self.client.force_authenticate(self.admin)
        self.origen = Sucursal.objects.create(nombre="Origen", direccion="Dir 1")
        self.destino = Sucursal.objects.create(nombre="Destino", direccion="Dir 2")
        tipo, _ = TipoDivision.objects.get_or_create(nombre="General")
        almacen = Bodega.objects.create(sucursal=self.destino, nombre="Almacén Destino")
        percha = Division.objects.create(bodega=almacen, tipo_division=tipo, nombre="Percha 1")
        self.nivel = SubDivision.objects.create(division=percha, nombre="Nivel 1")
        self.p1 = Producto.objects.create(codigo="RP-1", nombre="Filtro", precio=Decimal("10"))
        self.p2 = Producto.objects.create(codigo="RP-2", nombre="Pastilla", precio=Decimal("5"))

        tipo_entrada, _ = TipoMovimiento.objects.get_or_create(nombre="Entrada")
        tipo_salida, _ = TipoMovimiento.objects.get_or_create(nombre="Salida")
        sub_salida, _ = SubTipoMovimiento.objects.get_or_create(tipo_movimiento=tipo_salida, nombre="Traslado")
        sub_entrada, _ = SubTipoMovimiento.objects.get_or_create(tipo_movimiento=tipo_entrada, nombre="Traslado")
        enviado, _ = EstadoMovimiento.objects.get_or_create(nombre="Enviado")
        EstadoMovimiento.objects.get_or_create(nombre="Recibido")
        EstadoMovimiento.objects.get_or_create(nombre="Parcialmente recibido")
        estado_producto, _ = EstadoProducto.objects.get_or_create(nombre="Nuevo")

        self.solicitud = SolicitudTraslado.objects.create(
            sucursal_solicitante=self.destino,
            sucursal_proveedora=self.origen,
            fecha="2026-10-06",
            no_documento="TR-RP-1",
            estado=SolicitudTraslado.Estados.APROBADA,
        )
        salida = MovimientoInventario.objects.create(
            sucursal=self.origen, sucursal_objetivo=self.destino, tipo_movimiento=tipo_salida,
            sub_tipo_movimiento=sub_salida, estado_movimiento=enviado, fecha="2026-10-06", no_documento="TR-RP-1",
        )
        entrada = MovimientoInventario.objects.create(
            sucursal=self.destino, sucursal_objetivo=self.origen, tipo_movimiento=tipo_entrada,
            sub_tipo_movimiento=sub_entrada, estado_movimiento=enviado, fecha="2026-10-06", no_documento="TR-RP-1",
        )
        for producto, cantidad in ((self.p1, 5), (self.p2, 3)):
            SolicitudTrasladoDetalle.objects.create(
                solicitud=self.solicitud, producto=producto, cantidad=cantidad, valor=Decimal("1")
            )
            DetalleMovimiento.objects.create(
                movimiento_inventario=entrada, producto=producto, cantidad=cantidad,
                estado_producto=estado_producto, valor=Decimal("1"), valor_total=Decimal(cantidad),
            )
        self.solicitud.movimiento_salida = salida
        self.solicitud.movimiento_entrada = entrada
        self.solicitud.save(update_fields=["movimiento_salida", "movimiento_entrada"])

    def _stock(self, producto, subdivision=None):
        qs = Inventario.objects.filter(producto=producto, subdivision__division__bodega__sucursal=self.destino)
        if subdivision is not None:
            qs = qs.filter(subdivision=subdivision)
        return qs.aggregate(total=Sum("cantidad"))["total"] or 0

    def _por_ubicar(self):
        return SubDivision.objects.get(
            division__bodega__sucursal=self.destino, division__nombre=POR_UBICAR_NOMBRE, nombre=POR_UBICAR_NOMBRE
        )

    def _en_camino(self, producto):
        return (in_transit_by_product_branch([producto.id]).get((producto.id, self.destino.id)) or {}).get("total", 0)

    def test_recibir_sin_ubicacion_va_a_por_ubicar_y_se_puede_vender(self):
        self.assertEqual(self._en_camino(self.p1), 5)
        response = self.client.post(
            f"{BASE}/{self.solicitud.id}/recibir-parcial/",
            {"items": [{"producto_id": self.p1.id, "cantidad": 5}]},
            format="json",
        )
        self.assertEqual(response.status_code, 200, response.data)
        por_ubicar = self._por_ubicar()
        # La division temporal se crea en el almacen de la sucursal.
        self.assertEqual(por_ubicar.division.bodega.nombre, "Almacén Destino")
        self.assertEqual(self._stock(self.p1, por_ubicar), 5)
        self.assertEqual(self._en_camino(self.p1), 0)
        self.assertEqual(self._en_camino(self.p2), 3)
        progreso = response.data["recepcion_progreso"][str(self.p1.id)]
        self.assertEqual((progreso["recibido"], progreso["pendiente_guardar"]), (5, 5))

    def test_recibir_con_ubicacion_va_directo(self):
        response = self.client.post(
            f"{BASE}/{self.solicitud.id}/recibir-parcial/",
            {"items": [{"producto_id": self.p1.id, "cantidad": 5, "subdivision_id": self.nivel.id}]},
            format="json",
        )
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(self._stock(self.p1, self.nivel), 5)
        self.assertEqual(response.data["recepcion_progreso"][str(self.p1.id)]["pendiente_guardar"], 0)

    def test_guardar_mueve_lo_que_queda_en_por_ubicar(self):
        self.client.post(
            f"{BASE}/{self.solicitud.id}/recibir-parcial/",
            {"items": [{"producto_id": self.p1.id, "cantidad": 5}]},
            format="json",
        )
        por_ubicar = self._por_ubicar()
        # Se venden 2 desde POR UBICAR antes de guardar.
        fila = Inventario.objects.get(producto=self.p1, subdivision=por_ubicar)
        fila.cantidad = 3
        fila.save(update_fields=["cantidad"])

        response = self.client.post(
            f"{BASE}/{self.solicitud.id}/guardar-ubicaciones/",
            {"items": [{"producto_id": self.p1.id, "subdivision_id": self.nivel.id}]},
            format="json",
        )
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(self._stock(self.p1, self.nivel), 3)
        self.assertEqual(self._stock(self.p1, por_ubicar), 0)
        # Movido a su ubicacion: la fila de POR UBICAR no queda en 0, se quita.
        self.assertFalse(Inventario.objects.filter(producto=self.p1, subdivision=por_ubicar).exists())
        self.assertEqual(response.data["recepcion_progreso"][str(self.p1.id)]["pendiente_guardar"], 0)

    def test_cerrar_no_duplica_stock_y_exige_guardar_antes(self):
        self.client.post(
            f"{BASE}/{self.solicitud.id}/recibir-parcial/",
            {"items": [{"producto_id": self.p1.id, "cantidad": 5}, {"producto_id": self.p2.id, "cantidad": 2}]},
            format="json",
        )
        body = {
            "resultado": "incompleto",
            "items": [
                {"producto_id": self.p1.id, "cantidad_recibida": 5, "ubicaciones": []},
                {"producto_id": self.p2.id, "cantidad_recibida": 2, "ubicaciones": [], "novedad": "Falto uno"},
            ],
        }
        bloqueado = self.client.post(f"{BASE}/{self.solicitud.id}/confirmar-recepcion/", body, format="json")
        self.assertEqual(bloqueado.status_code, 400)

        self.client.post(
            f"{BASE}/{self.solicitud.id}/guardar-ubicaciones/",
            {"items": [
                {"producto_id": self.p1.id, "subdivision_id": self.nivel.id},
                {"producto_id": self.p2.id, "subdivision_id": self.nivel.id},
            ]},
            format="json",
        )
        response = self.client.post(f"{BASE}/{self.solicitud.id}/confirmar-recepcion/", body, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(self._stock(self.p1), 5)
        self.assertEqual(self._stock(self.p2), 2)
        self.assertEqual(self._en_camino(self.p2), 0)

    def test_guardar_no_acepta_mas_de_lo_que_hay_ni_por_ubicar_como_destino(self):
        self.client.post(
            f"{BASE}/{self.solicitud.id}/recibir-parcial/",
            {"items": [{"producto_id": self.p1.id, "cantidad": 2}]},
            format="json",
        )
        por_ubicar = self._por_ubicar()
        url = "/inventario/inventario/guardar-por-ubicar/"
        demasiado = self.client.post(url, {"items": [{"producto_id": self.p1.id, "sucursal_id": self.destino.id, "subdivision_id": self.nivel.id, "cantidad": 3}]}, format="json")
        self.assertEqual(demasiado.status_code, 400)
        mismo = self.client.post(url, {"items": [{"producto_id": self.p1.id, "sucursal_id": self.destino.id, "subdivision_id": por_ubicar.id}]}, format="json")
        self.assertEqual(mismo.status_code, 400)
        self.assertEqual(self._stock(self.p1, por_ubicar), 2)

    def test_recibir_otro_producto_o_cantidad_invalida(self):
        otro = Producto.objects.create(codigo="RP-X", nombre="Otro", precio=Decimal("1"))
        response = self.client.post(
            f"{BASE}/{self.solicitud.id}/recibir-parcial/",
            {"items": [{"producto_id": otro.id, "cantidad": 1}]},
            format="json",
        )
        self.assertEqual(response.status_code, 400)
        response = self.client.post(
            f"{BASE}/{self.solicitud.id}/recibir-parcial/",
            {"items": [{"producto_id": self.p1.id, "cantidad": 0}]},
            format="json",
        )
        self.assertEqual(response.status_code, 400)

    def _recibir(self, items):
        return self.client.post(f"{BASE}/{self.solicitud.id}/recibir-parcial/", {"items": items}, format="json")

    def test_recibir_dos_veces_lo_mismo_no_duplica(self):
        # Caso TR-SUR-TUM-17: el mismo check llega dos veces (doble click,
        # "marcar todos" o la recepcion automatica al abrir con datos viejos).
        primero = self._recibir([{"producto_id": self.p1.id, "cantidad": 5, "ya_recibido": 0}])
        self.assertEqual(primero.status_code, 200, primero.data)
        repetido = self._recibir([{"producto_id": self.p1.id, "cantidad": 5, "ya_recibido": 0}])
        self.assertEqual(repetido.status_code, 409, repetido.data)
        self.assertEqual(repetido.data["recepcion_progreso"][str(self.p1.id)]["recibido"], 5)
        # Aunque la pantalla vieja no mande ya_recibido, pasarse de lo enviado se rechaza.
        sin_marca = self._recibir([{"producto_id": self.p1.id, "cantidad": 5}])
        self.assertEqual(sin_marca.status_code, 409, sin_marca.data)
        self.assertEqual(self._stock(self.p1), 5)

    def test_no_se_recibe_mas_de_lo_enviado(self):
        response = self._recibir([{"producto_id": self.p2.id, "cantidad": 4}])
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self._stock(self.p2), 0)
        self._recibir([{"producto_id": self.p2.id, "cantidad": 2}])
        response = self._recibir([{"producto_id": self.p2.id, "cantidad": 2}])
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self._stock(self.p2), 2)

    def test_lote_con_error_no_deja_stock_a_medias(self):
        # Antes el primero quedaba sumado sin quedar en el avance y al
        # reintentarlo uno por uno se volvia a sumar.
        response = self._recibir([
            {"producto_id": self.p1.id, "cantidad": 5},
            {"producto_id": self.p2.id, "cantidad": 9},
        ])
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self._stock(self.p1), 0)
        self.solicitud.refresh_from_db()
        self.assertFalse(self.solicitud.recepcion_progreso)

    def test_cerrar_con_mas_de_lo_enviado_se_rechaza_y_no_crea_sobrante(self):
        from .models import TrasladoInconveniente

        body = {
            "resultado": "completo",
            "items": [
                {"producto_id": self.p1.id, "cantidad_recibida": 6,
                 "ubicaciones": [{"subdivision_id": self.nivel.id, "cantidad": 6}]},
                {"producto_id": self.p2.id, "cantidad_recibida": 3,
                 "ubicaciones": [{"subdivision_id": self.nivel.id, "cantidad": 3}]},
            ],
        }
        response = self.client.post(f"{BASE}/{self.solicitud.id}/confirmar-recepcion/", body, format="json")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self._stock(self.p1), 0)
        self.assertFalse(TrasladoInconveniente.objects.exists())


class RecepcionParcialImportacionTests(APITestCase):
    def setUp(self):
        from casa_comercial.models import CasaComercial

        User = get_user_model()
        self.admin = User.objects.create_superuser(
            username="admin-ri@test.com", email="admin-ri@test.com", password="x"
        )
        self.client.force_authenticate(self.admin)
        self.sucursal = Sucursal.objects.create(nombre="Norte", direccion="Av 1")
        Bodega.objects.create(sucursal=self.sucursal, nombre="Almacén Norte")
        casa = CasaComercial.objects.create(nombre="Casa", codigo="C1")
        importacion = Importacion.objects.create(codigo="IMP-RP-1", casa_comercial=casa)
        self.producto = Producto.objects.create(codigo="RI-1", nombre="Faro", precio=Decimal("10"))
        self.envio = ImportacionEnvio.objects.create(importacion=importacion, sucursal=self.sucursal)
        ImportacionEnvioDetalle.objects.create(envio=self.envio, producto=self.producto, cantidad=4)

    def test_recibir_por_partes_y_cerrar(self):
        transit = in_transit_by_product_branch([self.producto.id])[(self.producto.id, self.sucursal.id)]
        self.assertEqual(transit["total"], 4)
        self.assertEqual(transit["documentos"][0]["codigo"], "IMP-RP-1")

        url = f"/importaciones/importaciones/envios/{self.envio.id}"
        response = self.client.post(
            f"{url}/recibir-parcial/", {"items": [{"producto_id": self.producto.id, "cantidad": 4}]}, format="json"
        )
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(in_transit_by_product_branch([self.producto.id]), {})

        destino = SubDivision.objects.get(nombre=POR_UBICAR_NOMBRE, division__bodega__sucursal=self.sucursal)
        percha = Division.objects.create(
            bodega=destino.division.bodega, tipo_division=destino.division.tipo_division, nombre="B1"
        )
        nivel = SubDivision.objects.create(division=percha, nombre="01")
        self.client.post(
            f"{url}/guardar-ubicaciones/",
            {"items": [{"producto_id": self.producto.id, "subdivision_id": nivel.id}]},
            format="json",
        )
        response = self.client.post(
            f"{url}/confirmar-recepcion/",
            {"items": [{"producto_id": self.producto.id, "cantidad_recibida": 4, "ubicaciones": []}]},
            format="json",
        )
        self.assertEqual(response.status_code, 200, response.data)
        total = Inventario.objects.filter(producto=self.producto).aggregate(t=Sum("cantidad"))["t"]
        self.assertEqual(total, 4)
        self.envio.refresh_from_db()
        self.assertEqual(self.envio.estado, ImportacionEnvio.ESTADO_RECIBIDO)


class FaltanteEnvioImportacionTests(RecepcionParcialImportacionTests):
    def test_faltante_al_cerrar_queda_en_inconvenientes(self):
        from importaciones.models import ImportacionInconveniente

        url = f"/importaciones/importaciones/envios/{self.envio.id}"
        nivel = SubDivision.objects.create(
            division=Division.objects.create(
                bodega=Bodega.objects.get(sucursal=self.sucursal),
                tipo_division=TipoDivision.objects.get_or_create(nombre="General")[0],
                nombre="B1",
            ),
            nombre="01",
        )
        response = self.client.post(
            f"{url}/confirmar-recepcion/",
            {"items": [{
                "producto_id": self.producto.id,
                "cantidad_recibida": 3,
                "novedad": "Caja abierta",
                "ubicaciones": [{"subdivision_id": nivel.id, "cantidad": 3}],
            }]},
            format="json",
        )
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["faltantes"], 1)
        issue = ImportacionInconveniente.objects.get(producto=self.producto)
        self.assertEqual(issue.tipo, ImportacionInconveniente.Tipos.FALTANTE)
        self.assertEqual((issue.cantidad_esperada, issue.cantidad_recibida, issue.cantidad_diferencia), (4, 3, 1))
        self.assertIn("Norte", issue.motivo)
        self.assertIn("Caja abierta", issue.motivo)
        self.assertEqual(issue.estado, ImportacionInconveniente.Estados.PENDIENTE)

    def _faltante_de_envio(self):
        from importaciones.models import ImportacionInconveniente

        url = f"/importaciones/importaciones/envios/{self.envio.id}"
        self.nivel = SubDivision.objects.create(
            division=Division.objects.create(
                bodega=Bodega.objects.get(sucursal=self.sucursal),
                tipo_division=TipoDivision.objects.get_or_create(nombre="General")[0],
                nombre="B2",
            ),
            nombre="01",
        )
        self.client.post(
            f"{url}/confirmar-recepcion/",
            {"items": [{
                "producto_id": self.producto.id,
                "cantidad_recibida": 3,
                "ubicaciones": [{"subdivision_id": self.nivel.id, "cantidad": 3}],
            }]},
            format="json",
        )
        return ImportacionInconveniente.objects.get(producto=self.producto)

    def _resolver(self, issue, **body):
        return self.client.post(
            f"/importaciones/importaciones/inconvenientes/{issue.id}/resolver/", body, format="json"
        )

    def test_faltante_de_envio_se_resuelve_como_traslado(self):
        issue = self._faltante_de_envio()
        self.assertEqual(issue.envio_id, self.envio.id)
        # El reclamo al proveedor no aplica a lo que falto entre la importacion y la sucursal.

        response = self._resolver(issue, decision="sumar_solicitante", subdivision_id=self.nivel.id, motivo="Estaba en otra caja")
        self.assertEqual(response.status_code, 200, response.data)
        issue.refresh_from_db()
        self.assertEqual((issue.estado, issue.resolucion), ("resuelto", "sumado_sucursal"))
        self.assertIn("Norte", issue.motivo)  # se conserva la novedad original
        total = Inventario.objects.filter(producto=self.producto).aggregate(t=Sum("cantidad"))["t"]
        self.assertEqual(total, 4)

    def test_faltante_de_envio_desaparecido(self):
        issue = self._faltante_de_envio()
        response = self._resolver(issue, decision="perdido")
        self.assertEqual(response.status_code, 200, response.data)
        issue.refresh_from_db()
        self.assertEqual(issue.estado, "perdido")
        total = Inventario.objects.filter(producto=self.producto).aggregate(t=Sum("cantidad"))["t"]
        self.assertEqual(total, 3)

    def test_faltante_de_envio_se_suma_en_la_matriz(self):
        from importaciones.viewsets import get_matriz_sucursal

        matriz = get_matriz_sucursal() or Sucursal.objects.create(nombre="9 de Octubre (Matriz)", direccion="Av 9")
        nivel_matriz = SubDivision.objects.create(
            division=Division.objects.create(
                bodega=Bodega.objects.create(sucursal=matriz, nombre="Almacén Matriz"),
                tipo_division=TipoDivision.objects.get_or_create(nombre="General")[0],
                nombre="07:04",
            ),
            nombre="03",
        )
        issue = self._faltante_de_envio()
        listado = self.client.get("/importaciones/importaciones/inconvenientes/?estado=pendiente")
        fila = next(row for row in listado.data if row["id"] == issue.id)
        self.assertEqual(fila["sucursal_origen_id"], matriz.id)

        # Una ubicacion de Norte no vale para sumar en la matriz.
        self.assertEqual(self._resolver(issue, decision="sumar_origen", subdivision_id=self.nivel.id).status_code, 400)
        response = self._resolver(issue, decision="sumar_origen", subdivision_id=nivel_matriz.id)
        self.assertEqual(response.status_code, 200, response.data)
        issue.refresh_from_db()
        self.assertEqual(issue.resolucion, "sumado_origen")
        self.assertEqual(Inventario.objects.get(producto=self.producto, subdivision=nivel_matriz).cantidad, 1)


class LlegoImportacionAPorUbicarTests(RecepcionParcialImportacionTests):
    def test_cerrar_sin_ubicaciones_todo_queda_en_por_ubicar(self):
        url = f"/importaciones/importaciones/envios/{self.envio.id}"
        response = self.client.post(
            f"{url}/confirmar-recepcion/",
            {"items": [{"producto_id": self.producto.id, "cantidad_recibida": 4, "ubicaciones": []}]},
            format="json",
        )
        self.assertEqual(response.status_code, 200, response.data)
        destino = SubDivision.objects.get(nombre=POR_UBICAR_NOMBRE, division__bodega__sucursal=self.sucursal)
        self.assertEqual(Inventario.objects.get(producto=self.producto, subdivision=destino).cantidad, 4)
        lista = self.client.get("/inventario/inventario/por-guardar/").data["productos"]
        self.assertEqual([(row["producto_codigo"], row["cantidad"]) for row in lista], [("RI-1", 4)])


class FaltanteEnvioPorUbicarTests(FaltanteEnvioImportacionTests):
    def test_sumar_dejando_en_por_ubicar(self):
        issue = self._faltante_de_envio()
        response = self._resolver(issue, decision="sumar_solicitante", por_ubicar=True)
        self.assertEqual(response.status_code, 200, response.data)
        destino = SubDivision.objects.get(nombre=POR_UBICAR_NOMBRE, division__bodega__sucursal=self.sucursal)
        self.assertEqual(Inventario.objects.get(producto=self.producto, subdivision=destino).cantidad, 1)
        lista = self.client.get("/inventario/inventario/por-guardar/").data["productos"]
        self.assertEqual([(row["producto_codigo"], row["cantidad"]) for row in lista], [("RI-1", 1)])


class BorradorInconvenienteTests(FaltanteEnvioImportacionTests):
    """La solucion de cada producto se guarda como borrador y se limpia al aplicarla."""

    def test_borrador_de_importacion_se_guarda_y_se_limpia_al_resolver(self):
        issue = self._faltante_de_envio()
        url = "/importaciones/importaciones/inconvenientes/borradores/"
        response = self.client.post(url, {"items": [{"id": issue.id, "borrador": {
            "decision": "sumar_solicitante",
            "subdivision_id": self.nivel.id,
            "subdivision_label": "B2 / 01",
            "motivo": " Estaba en otra caja ",
            "desconocido": "x",
        }}]}, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["guardados"], [issue.id])
        issue.refresh_from_db()
        self.assertEqual(issue.borrador, {
            "decision": "sumar_solicitante",
            "subdivision_id": self.nivel.id,
            "subdivision_label": "B2 / 01",
            "motivo": "Estaba en otra caja",
        })
        # Guardar no toca el inventario.
        total = Inventario.objects.filter(producto=self.producto).aggregate(t=Sum("cantidad"))["t"]
        self.assertEqual(total, 3)
        fila = next(
            row for row in self.client.get("/importaciones/importaciones/inconvenientes/").data if row["id"] == issue.id
        )
        self.assertEqual(fila["borrador"]["decision"], "sumar_solicitante")

        response = self._resolver(issue, decision="sumar_solicitante", subdivision_id=self.nivel.id)
        self.assertEqual(response.status_code, 200, response.data)
        issue.refresh_from_db()
        self.assertEqual(issue.borrador, {})

        # Ya resuelto: el borrador no se vuelve a guardar.
        response = self.client.post(url, {"items": [{"id": issue.id, "borrador": {"decision": "perdido"}}]}, format="json")
        self.assertEqual(response.data["guardados"], [])
        issue.refresh_from_db()
        self.assertEqual(issue.borrador, {})

    def test_borrador_de_traslado_y_validaciones(self):
        from .models import TrasladoInconveniente

        solicitud = SolicitudTraslado.objects.create(
            sucursal_solicitante=self.sucursal,
            sucursal_proveedora=Sucursal.objects.create(nombre="Sur", direccion="Av 2"),
            fecha="2026-10-06", no_documento="TR-BORR-1", estado=SolicitudTraslado.Estados.APROBADA,
        )
        tipo_entrada, _ = TipoMovimiento.objects.get_or_create(nombre="Entrada")
        enviado, _ = EstadoMovimiento.objects.get_or_create(nombre="Enviado")
        entrada = MovimientoInventario.objects.create(
            sucursal=self.sucursal, tipo_movimiento=tipo_entrada, estado_movimiento=enviado,
            fecha="2026-10-06", no_documento="TR-BORR-1",
        )
        issue = TrasladoInconveniente.objects.create(
            solicitud=solicitud, movimiento_entrada=entrada, producto=self.producto, cantidad_faltante=2,
        )
        url = "/movimientos/movimiento_inventario/traslados-inconvenientes/borradores/"
        self.assertEqual(self.client.post(url, {"items": []}, format="json").status_code, 400)
        response = self.client.post(url, {"items": [{"id": issue.id, "borrador": {
            "decision": "inventada", "fecha_entrega_prometida": "no-fecha", "motivo": "Nota",
        }}]}, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        issue.refresh_from_db()
        self.assertEqual(issue.borrador, {"motivo": "Nota"})

        self.client.post(url, {"items": [{"id": issue.id, "borrador": {}}]}, format="json")
        issue.refresh_from_db()
        self.assertEqual(issue.borrador, {})


class LlegadaYConteoImportacionTests(RecepcionParcialImportacionTests):
    """Envio de importacion: 1) confirmar llegada: todo entra al stock en POR
    UBICAR (entre parentesis) y ya se puede vender; 2) "Por ubicar": se cuenta
    lo que queda y se guarda; al terminar, lo que no aparecio es faltante."""

    def setUp(self):
        super().setUp()
        self.url = f"/importaciones/importaciones/envios/{self.envio.id}"
        self.nivel = SubDivision.objects.create(
            division=Division.objects.create(
                bodega=Bodega.objects.get(sucursal=self.sucursal),
                tipo_division=TipoDivision.objects.get_or_create(nombre="General")[0],
                nombre="Conteo",
            ),
            nombre="01",
        )

    def _stock(self, subdivision=None):
        qs = Inventario.objects.filter(producto=self.producto, subdivision__division__bodega__sucursal=self.sucursal)
        if subdivision is not None:
            qs = qs.filter(subdivision=subdivision)
        return qs.aggregate(t=Sum("cantidad"))["t"] or 0

    def _vender(self, cantidad):
        from django.db import transaction

        from .serializers import MovimientoInventarioSerializer

        with transaction.atomic():
            MovimientoInventarioSerializer()._adjust_stock(self.sucursal, self.producto.id, -cantidad)

    def _envio_por_ubicar(self):
        lista = self.client.get("/inventario/inventario/por-guardar/").data
        return next(row for row in lista["envios"] if row["id"] == self.envio.id), lista

    def test_llegada_suma_en_por_ubicar_y_va_entre_parentesis(self):
        response = self.client.post(f"{self.url}/confirmar-llegada/")
        self.assertEqual(response.status_code, 200, response.data)
        # Repetir no suma dos veces.
        self.client.post(f"{self.url}/confirmar-llegada/")
        self.assertEqual(self._stock(), 4)
        self.assertEqual(self._stock(SubDivision.objects.get(nombre=POR_UBICAR_NOMBRE)), 4)

        transit = in_transit_by_product_branch([self.producto.id])[(self.producto.id, self.sucursal.id)]
        self.assertEqual((transit["total"], transit["por_contar"]), (0, 4))
        self.assertTrue(transit["documentos"][0]["llego"])

        pendientes = self.client.get("/importaciones/importaciones/envios-pendientes/").data
        self.assertNotIn(self.envio.id, [row["id"] for row in pendientes])
        envio, lista = self._envio_por_ubicar()
        self.assertEqual(envio["items"][0]["pendiente"], 4)
        # No sale repetido en lo suelto de POR UBICAR.
        self.assertEqual(lista["productos"], [])

    def test_lo_vendido_resta_del_parentesis(self):
        add = Inventario.objects.create(producto=self.producto, subdivision=self.nivel, cantidad=2)
        self.client.post(f"{self.url}/confirmar-llegada/")
        self._vender(3)
        add.refresh_from_db()
        self.assertEqual(add.cantidad, 2)  # se vende primero lo de POR UBICAR
        envio, _ = self._envio_por_ubicar()
        self.assertEqual((envio["items"][0]["vendido"], envio["items"][0]["pendiente"]), (3, 1))
        transit = in_transit_by_product_branch([self.producto.id])[(self.producto.id, self.sucursal.id)]
        self.assertEqual(transit["por_contar"], 1)

    def test_contar_guardar_y_terminar_con_faltante(self):
        from importaciones.models import ImportacionInconveniente

        self.client.post(f"{self.url}/confirmar-llegada/")
        self._vender(1)
        response = self.client.post(
            f"{self.url}/guardar-ubicaciones/",
            {"items": [{"producto_id": self.producto.id, "subdivision_id": self.nivel.id, "cantidad": 2}]},
            format="json",
        )
        self.assertEqual(response.status_code, 200, response.data)
        envio, _ = self._envio_por_ubicar()
        self.assertEqual(
            (envio["items"][0]["vendido"], envio["items"][0]["guardado"], envio["items"][0]["pendiente"]), (1, 2, 1)
        )

        response = self.client.post(f"{self.url}/terminar-conteo/")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["faltantes"], 1)
        self.assertEqual(self._stock(), 2)
        self.assertEqual(self._stock(self.nivel), 2)
        self.envio.refresh_from_db()
        self.assertEqual(self.envio.estado, ImportacionEnvio.ESTADO_RECIBIDO)
        issue = ImportacionInconveniente.objects.get(producto=self.producto, envio=self.envio)
        self.assertEqual((issue.cantidad_esperada, issue.cantidad_recibida, issue.cantidad_diferencia), (4, 3, 1))
        self.assertIn("vendidos antes de contar 1", issue.motivo)
        self.assertEqual(in_transit_by_product_branch([self.producto.id]), {})

    def test_todo_contado_termina_sin_faltantes(self):
        self.client.post(f"{self.url}/confirmar-llegada/")
        self._vender(4)
        response = self.client.post(f"{self.url}/terminar-conteo/")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data["faltantes"], 0)
        self.assertEqual(self._stock(), 0)

    def test_terminar_exige_llegada(self):
        self.assertEqual(self.client.post(f"{self.url}/terminar-conteo/").status_code, 400)

    def test_lo_del_envio_no_se_guarda_desde_por_ubicar_suelto(self):
        self.client.post(f"{self.url}/confirmar-llegada/")
        response = self.client.post(
            "/inventario/inventario/guardar-por-ubicar/",
            {"items": [{"producto_id": self.producto.id, "sucursal_id": self.sucursal.id,
                        "subdivision_id": self.nivel.id, "cantidad": 1}]},
            format="json",
        )
        self.assertEqual(response.status_code, 400)

    def test_si_se_vende_todo_el_envio_se_cierra_solo(self):
        from importaciones.models import ImportacionInconveniente

        self.client.post(f"{self.url}/confirmar-llegada/")
        self._vender(4)
        # Ya no queda nada por contar: al abrir "Por ubicar" el envio se
        # cierra solo (sin pendientes nadie podria terminar su conteo).
        lista = self.client.get("/inventario/inventario/por-guardar/").data
        self.assertNotIn(self.envio.id, [row["id"] for row in lista["envios"]])
        self.assertEqual(self.client.get("/inventario/inventario/por-guardar/?solo_conteo=1").data["count"], 0)
        self.envio.refresh_from_db()
        self.assertEqual(self.envio.estado, ImportacionEnvio.ESTADO_RECIBIDO)
        self.assertFalse(ImportacionInconveniente.objects.filter(envio=self.envio).exists())
        self.assertEqual(self._stock(), 0)

    def test_si_queda_algo_por_contar_el_envio_sigue_abierto(self):
        self.client.post(f"{self.url}/confirmar-llegada/")
        self._vender(3)
        envio, _ = self._envio_por_ubicar()
        self.assertEqual(envio["items"][0]["pendiente"], 1)
        self.envio.refresh_from_db()
        self.assertEqual(self.envio.estado, ImportacionEnvio.ESTADO_PENDIENTE)

    def test_lo_suelto_en_por_ubicar_vendido_desaparece(self):
        from django.db import transaction

        from inventario.por_ubicar import add_stock, get_por_ubicar_subdivision

        with transaction.atomic():
            add_stock(get_por_ubicar_subdivision(self.sucursal.id).id, self.producto.id, 1)
        lista = self.client.get("/inventario/inventario/por-guardar/").data
        self.assertEqual([row["producto_id"] for row in lista["productos"]], [self.producto.id])
        self.assertEqual(self.client.get("/inventario/inventario/por-guardar/?solo_conteo=1").data["count"], 1)

        self._vender(1)
        lista = self.client.get("/inventario/inventario/por-guardar/").data
        self.assertEqual(lista["productos"], [])
        self.assertEqual(self.client.get("/inventario/inventario/por-guardar/?solo_conteo=1").data["count"], 0)

    def test_cada_sucursal_ve_solo_su_por_ubicar(self):
        from unittest import mock

        from django.db import transaction

        from inventario.por_ubicar import add_stock, get_por_ubicar_subdivision

        sur = Sucursal.objects.create(nombre="Sur", direccion="Av 2")
        Bodega.objects.create(sucursal=sur, nombre="Almacén Sur")
        with transaction.atomic():
            add_stock(get_por_ubicar_subdivision(self.sucursal.id).id, self.producto.id, 2)
            add_stock(get_por_ubicar_subdivision(sur.id).id, self.producto.id, 5)

        def sucursales_de(ids):
            return mock.patch("inventario.viewsets.get_readable_sucursal_ids", return_value=ids)

        with sucursales_de([sur.id]):
            lista = self.client.get("/inventario/inventario/por-guardar/").data
        self.assertEqual(
            [(row["sucursal_id"], row["cantidad"]) for row in lista["productos"]], [(sur.id, 5)]
        )
        with sucursales_de([self.sucursal.id]):
            lista = self.client.get("/inventario/inventario/por-guardar/").data
        self.assertEqual(
            [(row["sucursal_id"], row["cantidad"]) for row in lista["productos"]], [(self.sucursal.id, 2)]
        )
        # Quien ve todas (None) ve las dos.
        lista = self.client.get("/inventario/inventario/por-guardar/").data
        self.assertEqual(sorted(row["sucursal_id"] for row in lista["productos"]), sorted([self.sucursal.id, sur.id]))

    def test_faltante_del_envio_se_reclama_al_proveedor(self):
        from importaciones.models import ImportacionInconveniente

        self.client.post(f"{self.url}/confirmar-llegada/")
        self.client.post(f"{self.url}/terminar-conteo/")
        issue = ImportacionInconveniente.objects.get(producto=self.producto, envio=self.envio)
        self.assertEqual(issue.cantidad_diferencia, 4)
        fila = next(
            row for row in self.client.get("/importaciones/importaciones/inconvenientes/").data if row["id"] == issue.id
        )
        self.assertIn("llegada_facturado", fila)

        url = f"/importaciones/importaciones/inconvenientes/{issue.id}/resolver/"
        response = self.client.post(url, {"decision": "reportado_proveedor"}, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        issue.refresh_from_db()
        self.assertEqual((issue.estado, issue.resolucion), ("reclamado", "reportado_proveedor"))
        self.assertEqual(self._stock(), 0)
        # Sigue como un reclamo normal al proveedor.
        response = self.client.post(
            url, {"decision": "solucion", "cantidad_prometida": 4, "fecha_entrega_prometida": "2026-11-15"},
            format="json",
        )
        self.assertEqual(response.status_code, 200, response.data)
