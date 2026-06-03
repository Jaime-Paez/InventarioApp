from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("casa_comercial", "0004_casacomercial_remove_unique_codigo"),
    ]

    operations = [
        migrations.AddField(
            model_name="casacomercial",
            name="dias_entrega",
            field=models.PositiveSmallIntegerField(
                blank=True,
                null=True,
                help_text="Días aproximados que tarda la casa comercial en entregar mercadería.",
            ),
        ),
    ]
