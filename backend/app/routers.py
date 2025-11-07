from rest_framework import routers

# Cambia el título del root y conserva el listado tipo dict
class CustomRouter(routers.DefaultRouter):
    APIRootView = type(
        "ApiRootView",
        (routers.APIRootView,),
        {"__doc__": "Api Grouped Root"}  # título que verás en la UI
    )
