export const CAUSAL_GOLDEN_FIXTURES = {
  "Export Completion and Webhook Notification": [
    "event ExportCompleted", "event WebhookNotificationRequested", "handler Export", "handler Webhook",
    "ExportCompleted handled by Export", "Export causes WebhookNotificationRequested", "WebhookNotificationRequested handled by Webhook",
    "effect archive on Export: archive export", "effect notify on Webhook: enqueue webhook notification",
  ],
  "UpOne Account and Transaction Fan-out": [
    "event UpOneTransactionRaisedEvent", "event SaveUpOneTransactionCommand", "event AddAccountCommand", "event AddCorporateAccountCommand",
    "handler TransactionsHandler", "handler AccountsHandler", "UpOneTransactionRaisedEvent handled by TransactionsHandler", "UpOneTransactionRaisedEvent handled by AccountsHandler",
    "TransactionsHandler causes SaveUpOneTransactionCommand", "AccountsHandler causes AddAccountCommand", "AccountsHandler causes AddCorporateAccountCommand",
    "effect save-transaction on TransactionsHandler: save transaction", "effect update-account on AccountsHandler: update account",
  ],
  "Webhook Delivery Retry": [
    "event WebhookDeliveryRequested", "event WebhookDelivered", "handler WebhookDelivery", "WebhookDeliveryRequested handled by WebhookDelivery", "WebhookDelivery causes WebhookDelivered",
    "effect send-webhook on WebhookDelivery: send webhook", "failure webhook-send-failed on effect send-webhook", "retry webhook-send-again for webhook-send-failed {", "  mechanism: handler", "  target: same-execution", "  max-attempts: 3", "}",
  ],
  "Monthly Billing": [
    "event InvoiceDue", "event InvoiceIssued", "handler MonthlyBilling", "InvoiceDue handled by MonthlyBilling", "MonthlyBilling causes InvoiceIssued",
    "effect update-ledger on MonthlyBilling: update ledger", "effect notify-customer on MonthlyBilling: notify customer", "failure ledger-update-failed on effect update-ledger", "retry ledger-update-again for ledger-update-failed {", "  mechanism: scheduler", "  target: same-execution", "}",
  ],
  "Programmed Recharge": [
    "event RechargeRequested", "event BalanceLoaded", "event RechargeAuthorized", "event PaymentCaptured", "event RechargeCompleted", "event NotificationQueued", "event LedgerUpdated",
    "handler LoadBalance", "handler AuthorizeRecharge", "handler CapturePayment", "handler CompleteRecharge", "handler NotifyCustomer",
    "RechargeRequested handled by LoadBalance", "LoadBalance causes BalanceLoaded", "BalanceLoaded handled by AuthorizeRecharge", "AuthorizeRecharge causes RechargeAuthorized", "RechargeAuthorized handled by CapturePayment", "CapturePayment causes PaymentCaptured", "PaymentCaptured handled by CompleteRecharge", "CompleteRecharge causes RechargeCompleted", "RechargeCompleted handled by NotifyCustomer", "NotifyCustomer causes NotificationQueued", "CompleteRecharge causes LedgerUpdated", "LedgerUpdated handled by NotifyCustomer",
    "effect persist-recharge on CompleteRecharge: persist recharge", "effect audit-recharge on CompleteRecharge: append audit record", "failure capture-failed on handler CapturePayment", "retry capture-again for capture-failed {", "  mechanism: handler", "  target: same-execution", "}",
  ],
  "Disconnected components": [
    "event Primary", "event Isolated", "handler PrimaryHandler", "Primary handled by PrimaryHandler", "effect persist on PrimaryHandler: persist primary state",
  ],
  "Branch and converge": [
    "event Root", "event Left", "event Right", "event Joined", "handler FanOut", "handler MergeLeft", "handler MergeRight",
    "Root handled by FanOut", "FanOut causes Left", "FanOut causes Right", "Left handled by MergeLeft", "Right handled by MergeRight",
    "MergeLeft causes Joined", "MergeRight causes Joined",
  ],
  "Disconnected causal components": [
    "event First", "event Second", "event Isolated", "handler FirstHandler", "handler SecondHandler",
    "First handled by FirstHandler", "Second handled by SecondHandler", "effect persist-first on FirstHandler: persist first", "effect persist-second on SecondHandler: persist second",
  ],
  "Cyclic failure retry": [
    "event Work", "handler Worker", "Work handled by Worker", "failure worker-failed on handler Worker",
    "retry retry-worker for worker-failed {", "  mechanism: handler", "  target: same-execution", "}",
  ],
} as const;
