from django.test import TestCase

from app.views import (
    _hydrate_transfer_history_from_solicitudes,
    _merge_reminder,
    _sanitize_transfer_history,
)
from inventario.models import Sucursal
from movimientos.models import SolicitudTraslado
from movimientos.viewsets import MovimientoInventarioViewSet


class TransferReminderHistoryTests(TestCase):
    def test_sanitize_transfer_history_preserves_multiple_entries_of_same_stage(self):
        history = [
            {
                "stage": "rechazada",
                "description": "Su solicitud fue rechazada. Motivo: uno",
                "at": "2026-04-21T19:00:00Z",
                "actor": {"id": "7", "name": "Tumbaco Prueba"},
            },
            {
                "stage": "pendiente",
                "description": "Solicitud de traslado #TR-1. Revisar gestion pendiente.",
                "at": "2026-04-21T19:05:00Z",
                "actor": {"id": "8", "name": "9 de Octubre Prueba"},
            },
            {
                "stage": "rechazada",
                "description": "Su solicitud fue rechazada. Motivo: dos",
                "at": "2026-04-21T19:10:00Z",
                "actor": {"id": "7", "name": "Tumbaco Prueba"},
            },
        ]

        result = _sanitize_transfer_history(history)

        self.assertEqual(len(result), 3)
        self.assertEqual(
            [entry["stage"] for entry in result],
            ["rechazada", "pendiente", "rechazada"],
        )
        self.assertEqual(
            [entry["description"] for entry in result],
            [
                "Su solicitud fue rechazada. Motivo: uno",
                "Solicitud de traslado #TR-1. Revisar gestion pendiente.",
                "Su solicitud fue rechazada. Motivo: dos",
            ],
        )

    def test_sanitize_transfer_history_collapses_only_near_duplicate_events(self):
        history = [
            {
                "stage": "rechazada",
                "description": "Su solicitud fue rechazada. Motivo: miau",
                "at": "2026-04-21T19:37:58.284000Z",
                "actor": {"id": "7", "name": "Tumbaco Prueba"},
            },
            {
                "stage": "rechazada",
                "description": "Su solicitud fue rechazada. Motivo: miau",
                "at": "2026-04-21T19:37:58.898000Z",
                "actor": {"id": "7", "name": "Tumbaco Prueba"},
            },
            {
                "stage": "rechazada",
                "description": "Su solicitud fue rechazada. Motivo: nooo",
                "at": "2026-04-21T19:39:58.898000Z",
                "actor": {"id": "7", "name": "Tumbaco Prueba"},
            },
        ]

        result = _sanitize_transfer_history(history)

        self.assertEqual(len(result), 2)
        self.assertEqual(
            [entry["description"] for entry in result],
            [
                "Su solicitud fue rechazada. Motivo: miau",
                "Su solicitud fue rechazada. Motivo: nooo",
            ],
        )

    def test_merge_reminder_keeps_full_rejection_and_correction_cycle(self):
        base_reminder = {
            "id": "rem-1",
            "date": "2026-04-21",
            "time": "19:00",
            "description": "Solicitud de traslado #TR-1. Revisar gestion pendiente.",
            "creator": {"id": "8", "name": "9 de Octubre Prueba"},
            "recipients": [{"id": "7", "name": "Tumbaco Prueba"}],
            "context": {"type": "solicitud_traslado", "id": "146", "label": "Solicitud de traslado #TR-1"},
            "kind": "solicitud_traslado_decision",
            "decision": {
                "status": "pendiente",
                "reason": "",
                "by": None,
                "at": "",
                "assignedRecipients": [{"id": "7", "name": "Tumbaco Prueba"}],
            },
            "transferHistory": [
                {
                    "stage": "pendiente",
                    "description": "Solicitud de traslado #TR-1. Revisar gestion pendiente.",
                    "at": "2026-04-21T19:00:00Z",
                    "actor": {"id": "8", "name": "9 de Octubre Prueba"},
                }
            ],
            "createdAt": "2026-04-21T19:00:00Z",
            "completedBy": [],
        }
        first_rejection = {
            **base_reminder,
            "kind": "recordatorio_general",
            "description": "Su solicitud fue rechazada. Motivo: uno",
            "decision": {
                "status": "rechazada",
                "reason": "uno",
                "by": {"id": "7", "name": "Tumbaco Prueba"},
                "at": "2026-04-21T19:02:00Z",
                "assignedRecipients": [{"id": "7", "name": "Tumbaco Prueba"}],
            },
            "transferHistory": [
                {
                    "stage": "rechazada",
                    "description": "Su solicitud fue rechazada. Motivo: uno",
                    "at": "2026-04-21T19:02:00Z",
                    "actor": {"id": "7", "name": "Tumbaco Prueba"},
                }
            ],
        }
        correction = {
            **base_reminder,
            "time": "19:05",
            "decision": {
                "status": "pendiente",
                "reason": "",
                "by": None,
                "at": "",
                "assignedRecipients": [{"id": "7", "name": "Tumbaco Prueba"}],
            },
            "transferHistory": [
                {
                    "stage": "pendiente",
                    "description": "Solicitud de traslado #TR-1. Revisar gestion pendiente.",
                    "at": "2026-04-21T19:05:00Z",
                    "actor": {"id": "8", "name": "9 de Octubre Prueba"},
                }
            ],
        }
        second_rejection = {
            **base_reminder,
            "time": "19:07",
            "kind": "recordatorio_general",
            "description": "Su solicitud fue rechazada. Motivo: dos",
            "decision": {
                "status": "rechazada",
                "reason": "dos",
                "by": {"id": "7", "name": "Tumbaco Prueba"},
                "at": "2026-04-21T19:07:00Z",
                "assignedRecipients": [{"id": "7", "name": "Tumbaco Prueba"}],
            },
            "transferHistory": [
                {
                    "stage": "rechazada",
                    "description": "Su solicitud fue rechazada. Motivo: dos",
                    "at": "2026-04-21T19:07:00Z",
                    "actor": {"id": "7", "name": "Tumbaco Prueba"},
                }
            ],
        }

        merged = _merge_reminder(base_reminder, first_rejection)
        merged = _merge_reminder(merged, correction)
        merged = _merge_reminder(merged, second_rejection)

        self.assertIsNotNone(merged)
        self.assertEqual(
            [entry["stage"] for entry in merged["transferHistory"]],
            ["pendiente", "rechazada", "pendiente", "rechazada"],
        )
        self.assertEqual(
            [entry["description"] for entry in merged["transferHistory"]],
            [
                "Solicitud de traslado #TR-1. Revisar gestion pendiente.",
                "Su solicitud fue rechazada. Motivo: uno",
                "Solicitud de traslado #TR-1. Revisar gestion pendiente.",
                "Su solicitud fue rechazada. Motivo: dos",
            ],
        )


class SolicitudTrasladoHistoryPersistenceTests(TestCase):
    def setUp(self):
        self.sucursal_solicitante = Sucursal.objects.create(
            nombre="9 de Octubre Prueba",
            direccion="Centro",
        )
        self.sucursal_proveedora = Sucursal.objects.create(
            nombre="Tumbaco Prueba",
            direccion="Valle",
        )
        self.solicitud = SolicitudTraslado.objects.create(
            sucursal_solicitante=self.sucursal_solicitante,
            sucursal_proveedora=self.sucursal_proveedora,
            descripcion="Solicitud de prueba",
            fecha="2026-04-21",
            no_documento="TR-TUM-9OCT-TEST-1",
        )
        self.viewset = MovimientoInventarioViewSet()
        self.actor_solicitante = {"id": "8", "name": "9 de Octubre Prueba"}
        self.actor_proveedora = {"id": "7", "name": "Tumbaco Prueba"}

    def test_historial_persistente_soporta_ciclos_indefinidos_de_rechazo_y_correccion(self):
        events = [
            (
                "pendiente",
                "Solicitud de traslado #TR-TUM-9OCT-TEST-1. Revisar gestion pendiente.",
                self.actor_solicitante,
                "2026-04-21T19:00:00Z",
            ),
            (
                "rechazada",
                "Su solicitud de traslado #TR-TUM-9OCT-TEST-1 fue rechazada. Motivo: uno",
                self.actor_proveedora,
                "2026-04-21T19:01:00Z",
            ),
            (
                "pendiente",
                "Solicitud de traslado #TR-TUM-9OCT-TEST-1. Revisar gestion pendiente.",
                self.actor_solicitante,
                "2026-04-21T19:02:00Z",
            ),
            (
                "rechazada",
                "Su solicitud de traslado #TR-TUM-9OCT-TEST-1 fue rechazada. Motivo: dos",
                self.actor_proveedora,
                "2026-04-21T19:03:00Z",
            ),
            (
                "pendiente",
                "Solicitud de traslado #TR-TUM-9OCT-TEST-1. Revisar gestion pendiente.",
                self.actor_solicitante,
                "2026-04-21T19:04:00Z",
            ),
            (
                "rechazada",
                "Su solicitud de traslado #TR-TUM-9OCT-TEST-1 fue rechazada. Motivo: tres",
                self.actor_proveedora,
                "2026-04-21T19:05:00Z",
            ),
        ]

        history = []
        for stage, description, actor, at in events:
            history = self.viewset._append_solicitud_transfer_history_event(
                solicitud=self.solicitud,
                stage=stage,
                description=description,
                actor=actor,
                at=at,
            )

        self.solicitud.refresh_from_db()

        self.assertEqual(len(history), 6)
        self.assertEqual(
            [entry["stage"] for entry in history],
            ["pendiente", "rechazada", "pendiente", "rechazada", "pendiente", "rechazada"],
        )
        self.assertEqual(
            [entry["description"] for entry in self.solicitud.historial_transfer],
            [event[1] for event in events],
        )

    def test_historial_persistente_recupera_eventos_previos_desde_recordatorios(self):
        seed_history = [
            self.viewset._build_transfer_history_entry(
                stage="pendiente",
                description="Solicitud de traslado #TR-TUM-9OCT-TEST-1. Revisar gestion pendiente.",
                actor=self.actor_solicitante,
                at="2026-04-21T19:00:00Z",
            ),
            self.viewset._build_transfer_history_entry(
                stage="rechazada",
                description="Su solicitud de traslado #TR-TUM-9OCT-TEST-1 fue rechazada. Motivo: uno",
                actor=self.actor_proveedora,
                at="2026-04-21T19:01:00Z",
            ),
            self.viewset._build_transfer_history_entry(
                stage="pendiente",
                description="Solicitud de traslado #TR-TUM-9OCT-TEST-1. Revisar gestion pendiente.",
                actor=self.actor_solicitante,
                at="2026-04-21T19:02:00Z",
            ),
        ]

        history = self.viewset._append_solicitud_transfer_history_event(
            solicitud=self.solicitud,
            stage="rechazada",
            description="Su solicitud de traslado #TR-TUM-9OCT-TEST-1 fue rechazada. Motivo: dos",
            actor=self.actor_proveedora,
            at="2026-04-21T19:03:00Z",
            seed_history=seed_history,
        )

        self.solicitud.refresh_from_db()

        self.assertEqual(len(history), 4)
        self.assertEqual(
            [entry["stage"] for entry in self.solicitud.historial_transfer],
            ["pendiente", "rechazada", "pendiente", "rechazada"],
        )
        self.assertEqual(
            self.solicitud.historial_transfer[-1]["description"],
            "Su solicitud de traslado #TR-TUM-9OCT-TEST-1 fue rechazada. Motivo: dos",
        )

    def test_hydrate_transfer_history_from_solicitudes_recovers_missing_cycles(self):
        self.solicitud.historial_transfer = [
            self.viewset._build_transfer_history_entry(
                stage="pendiente",
                description="Solicitud de traslado #TR-TUM-9OCT-TEST-1. Revisar gestion pendiente.",
                actor=self.actor_solicitante,
                at="2026-04-21T19:00:00Z",
            ),
            self.viewset._build_transfer_history_entry(
                stage="rechazada",
                description="Su solicitud de traslado #TR-TUM-9OCT-TEST-1 fue rechazada. Motivo: 1",
                actor=self.actor_proveedora,
                at="2026-04-21T19:01:00Z",
            ),
            self.viewset._build_transfer_history_entry(
                stage="pendiente",
                description="Solicitud de traslado #TR-TUM-9OCT-TEST-1. Revisar gestion pendiente.",
                actor=self.actor_solicitante,
                at="2026-04-21T19:02:00Z",
            ),
            self.viewset._build_transfer_history_entry(
                stage="rechazada",
                description="Su solicitud de traslado #TR-TUM-9OCT-TEST-1 fue rechazada. Motivo: 2",
                actor=self.actor_proveedora,
                at="2026-04-21T19:03:00Z",
            ),
            self.viewset._build_transfer_history_entry(
                stage="pendiente",
                description="Solicitud de traslado #TR-TUM-9OCT-TEST-1. Revisar gestion pendiente.",
                actor=self.actor_solicitante,
                at="2026-04-21T19:04:00Z",
            ),
        ]
        self.solicitud.save(update_fields=["historial_transfer", "updated_at"])

        reminders, changed = _hydrate_transfer_history_from_solicitudes(
            [
                {
                    "id": "rem-148",
                    "date": "2026-04-21",
                    "time": "15:26",
                    "description": "Solicitud de traslado #TR-TUM-9OCT-TEST-1. Revisar gestion pendiente.",
                    "creator": self.actor_solicitante,
                    "recipients": [self.actor_solicitante, self.actor_proveedora],
                    "context": {
                        "type": "solicitud_traslado",
                        "id": str(self.solicitud.id),
                        "label": "Solicitud de traslado #TR-TUM-9OCT-TEST-1",
                    },
                    "kind": "solicitud_traslado_decision",
                    "decision": {
                        "status": "pendiente",
                        "reason": "",
                        "by": None,
                        "at": "",
                        "assignedRecipients": [self.actor_proveedora],
                    },
                    "transferHistory": [
                        self.viewset._build_transfer_history_entry(
                            stage="rechazada",
                            description="Su solicitud de traslado #TR-TUM-9OCT-TEST-1 fue rechazada. Motivo: 2",
                            actor=self.actor_proveedora,
                            at="2026-04-21T19:03:00Z",
                        ),
                        self.viewset._build_transfer_history_entry(
                            stage="pendiente",
                            description="Solicitud de traslado #TR-TUM-9OCT-TEST-1. Revisar gestion pendiente.",
                            actor=self.actor_solicitante,
                            at="2026-04-21T19:04:00Z",
                        ),
                    ],
                    "createdAt": "2026-04-21T19:00:00Z",
                    "completedBy": [],
                }
            ]
        )

        self.assertTrue(changed)
        self.assertEqual(len(reminders), 1)
        self.assertEqual(
            [entry["description"] for entry in reminders[0]["transferHistory"]],
            [
                "Solicitud de traslado #TR-TUM-9OCT-TEST-1. Revisar gestion pendiente.",
                "Su solicitud de traslado #TR-TUM-9OCT-TEST-1 fue rechazada. Motivo: 1",
                "Solicitud de traslado #TR-TUM-9OCT-TEST-1. Revisar gestion pendiente.",
                "Su solicitud de traslado #TR-TUM-9OCT-TEST-1 fue rechazada. Motivo: 2",
                "Solicitud de traslado #TR-TUM-9OCT-TEST-1. Revisar gestion pendiente.",
            ],
        )
