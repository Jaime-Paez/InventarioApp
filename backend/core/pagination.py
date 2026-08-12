from rest_framework.pagination import PageNumberPagination


class StandardResultsSetPagination(PageNumberPagination):
    page_size_query_param = "page_size"
    # Este es el limite real, no un default -- DRF recorta cualquier
    # page_size pedido por el cliente a esto, sin avisar. Varias pantallas
    # (recepcion de envios, resolver ubicaciones faltantes) piden todo en
    # un solo fetch asumiendo que lo recibieron completo, sin paginar; con
    # el limite en 500 se quedaban cortas en la sucursal mas grande (775
    # subdivisiones) y esas ubicaciones quedaban invisibles sin ningun
    # error visible. 2000 deja margen amplio sobre el maximo real de hoy.
    max_page_size = 2000
