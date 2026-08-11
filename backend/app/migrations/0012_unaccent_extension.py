from django.contrib.postgres.operations import UnaccentExtension
from django.db import migrations


class Migration(migrations.Migration):
    """
    Habilita la extension unaccent de Postgres para que las busquedas por
    nombre (clientes, productos, etc.) no fallen cuando el usuario escribe
    sin tildes/eñes pero el dato guardado si las tiene (ej. "Jose Pena" no
    encontraba a "Jose Peña"). Es global a la base de datos, no a una
    tabla puntual, por eso vive en esta app de infraestructura comun en
    vez de en el modelo especifico que la disparo (Cliente).
    """

    dependencies = [
        ("app", "0011_inspeccionaleatoriadiaria_nota_general"),
    ]

    operations = [
        UnaccentExtension(),
    ]
