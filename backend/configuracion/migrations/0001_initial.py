from decimal import Decimal

from django.db import migrations, models


def seed_configuracion(apps, schema_editor):
    ConfiguracionSistema = apps.get_model("configuracion", "ConfiguracionSistema")
    if not ConfiguracionSistema.objects.exists():
        ConfiguracionSistema.objects.create(iva_rate=Decimal("0.15"))


class Migration(migrations.Migration):
    initial = True

    dependencies = []

    operations = [
        migrations.CreateModel(
            name="ConfiguracionSistema",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                (
                    "iva_rate",
                    models.DecimalField(
                        decimal_places=4,
                        default=Decimal("0.15"),
                        help_text="IVA aplicado en el sistema, expresado como decimal (ej: 0.15).",
                        max_digits=5,
                    ),
                ),
                ("actualizado_en", models.DateTimeField(auto_now=True)),
            ],
            options={
                "verbose_name": "Configuracion del sistema",
                "verbose_name_plural": "Configuracion del sistema",
            },
        ),
        migrations.RunPython(seed_configuracion, migrations.RunPython.noop),
    ]
