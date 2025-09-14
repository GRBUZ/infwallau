# Manual refunds (runbook)

Ce dossier contient des **tickets JSON** créés automatiquement quand un **refund PayPal automatique a échoué**.
Aucun secret ici — uniquement des métadonnées utiles au back-office pour traiter manuellement.

## Où arrivent les fichiers ?
`ops/manual-refunds/YYYY/MM/DD/<orderId>__<captureId>__<timestamp>_<rand>.json`

## Payload type
```json
{
  "type": "manual_refund_needed",
  "createdAt": 1736275200000,
  "createdAtIso": "2025-01-07T12:00:00.000Z",
  "orderId": "ord_abcd1234_efgh",
  "uid": "user_xxx",
  "regionId": "54f3f1d2-7c3a-4b43-8b8a-9f2b6c5a1d90",
  "blocks": [1234, 1235, 1334],
  "amount": 12.34,
  "currency": "USD",
  "paypalOrderId": "5R12345678901234X",
  "paypalCaptureId": "1AB23456CD7890123",
  "reason": "FINALIZE_ERROR",
  "error": "REFUND_FAILED: UNPROCESSABLE_ENTITY",
  "route": "capture-finalize" // ou "webhook"
}

## Procédure opérateur

Vérifier l’ordre dans Supabase

Table orders par order_id.

S’assurer que needs_manual_refund = true et refund_status = 'failed'.

Lire paypal_capture_id et paypal_order_id.

Faire le refund dans PayPal (compte marchand)

Trouver la capture par paypalCaptureId.

Émettre un refund total (montant amount du JSON) — ou partiel si précisé.

Répercuter en base

Mettre à jour la ligne orders (par order_id) :

status = 'refunded'

refund_status = 'succeeded'

needs_manual_refund = false

refund_id = '<refundId retourné par PayPal>'

refund_attempted_at = now()

updated_at = now()

(optionnel) fail_reason si pertinent

Exemple SQL:

update orders
set status='refunded',
    refund_status='succeeded',
    needs_manual_refund=false,
    refund_id='<REFUND_ID>',
    refund_attempted_at=now(),
    updated_at=now()
where order_id = '<ORDER_ID>';


Clore le ticket GitHub

Tu peux supprimer le JSON ou le déplacer dans ops/manual-refunds/done/.

Alternative: ajouter un commentaire de commit “refund completed: <REFUND_ID>”.

Notes

Si tu ne veux plus de logging GitHub, retire GH_REPO ou GH_TOKEN du deploy — le logger devient no-op.

Ces JSON n’ont aucun secret et servent uniquement de file d’attente visuelle pour l’équipe ops.