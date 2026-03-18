from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("productos", "0009_remove_producto_marca"),
    ]

    operations = [
        migrations.AddField(
            model_name="producto",
            name="referencia",
            field=models.CharField(blank=True, max_length=200),
        ),
    ]
