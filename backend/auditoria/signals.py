"""
Audit signals – capture CRUD operations on watched models.

Thread-local storage is used to propagate the current request user
(set by AuditMiddleware) into the signal handlers.
"""
import threading
from datetime import date, datetime
from decimal import Decimal

from django.contrib.contenttypes.models import ContentType
from django.db.models.signals import post_delete, post_save, pre_save

_local = threading.local()


def get_current_user():
    return getattr(_local, "current_user", None)


def set_current_user(user):
    _local.current_user = user


def _serialize_instance(instance):
    """Return a JSON-serializable dict of the instance's concrete fields."""
    data = {}
    try:
        for field in instance._meta.concrete_fields:
            val = getattr(instance, field.attname, None)
            if isinstance(val, (datetime, date)):
                data[field.attname] = val.isoformat()
            elif isinstance(val, Decimal):
                data[field.attname] = float(val)
            else:
                data[field.attname] = val
    except Exception:
        pass
    return data


def _pre_save_handler(sender, instance, **kwargs):
    """Snapshot old values before an update so we can diff them later."""
    if instance.pk:
        try:
            old = sender.objects.get(pk=instance.pk)
            instance._audit_old_values = _serialize_instance(old)
        except sender.DoesNotExist:
            instance._audit_old_values = None
    else:
        instance._audit_old_values = None


def _post_save_handler(sender, instance, created, **kwargs):
    from auditoria.models import RegistroAuditoria  # avoid circular import

    user = get_current_user()
    ct = ContentType.objects.get_for_model(instance)
    new_vals = _serialize_instance(instance)
    old_vals = getattr(instance, "_audit_old_values", None)

    RegistroAuditoria.objects.create(
        usuario=user,
        accion=(
            RegistroAuditoria.Acciones.CREACION
            if created
            else RegistroAuditoria.Acciones.ACTUALIZACION
        ),
        content_type=ct,
        object_id=str(instance.pk),
        representacion_objeto=str(instance)[:255],
        valores_previos=None if created else old_vals,
        valores_nuevos=new_vals,
    )


def _post_delete_handler(sender, instance, **kwargs):
    from auditoria.models import RegistroAuditoria  # avoid circular import

    user = get_current_user()
    ct = ContentType.objects.get_for_model(instance)

    RegistroAuditoria.objects.create(
        usuario=user,
        accion=RegistroAuditoria.Acciones.ELIMINACION,
        content_type=ct,
        object_id=str(instance.pk),
        representacion_objeto=str(instance)[:255],
        valores_previos=_serialize_instance(instance),
        valores_nuevos=None,
    )


def register_audit_signals(model):
    """Wire pre_save / post_save / post_delete signals for *model*."""
    name = f"{model._meta.app_label}_{model.__name__}"
    pre_save.connect(
        _pre_save_handler,
        sender=model,
        weak=False,
        dispatch_uid=f"audit_pre_{name}",
    )
    post_save.connect(
        _post_save_handler,
        sender=model,
        weak=False,
        dispatch_uid=f"audit_post_{name}",
    )
    post_delete.connect(
        _post_delete_handler,
        sender=model,
        weak=False,
        dispatch_uid=f"audit_del_{name}",
    )
