from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("movimientos", "0009_solicitudtraslado_creado_por_enviado_por"),
    ]

    operations = [
        migrations.AddField(
            model_name="trasladoinconveniente",
            name="tipo",
            field=models.CharField(
                choices=[("faltante", "Faltante"), ("sobrante", "Sobrante")],
                default="faltante",
                max_length=20,
            ),
        ),
        migrations.AlterField(
            model_name="trasladoinconveniente",
            name="resolucion",
            field=models.CharField(
                blank=True,
                choices=[
                    ("sumar_solicitante", "Sumar a sucursal solicitante"),
                    ("sumar_proveedora", "Sumar a sucursal proveedora"),
                    ("perdido", "Perdido / robado / no recuperado"),
                    ("restar_proveedora", "Restar de sucursal proveedora"),
                    ("sin_cambios", "Sin cambios de inventario"),
                ],
                default="",
                max_length=30,
            ),
        ),
    ]
