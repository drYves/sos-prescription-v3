import { NdjsonLogger } from "../logger";
import { PrismaJobsRepo, type PaymentActionJobRecord } from "../jobs/prismaJobsRepo";
import { StripeGateway, StripeGatewayError, type StripePaymentIntentRecord } from "./stripeClient";
import { WordPressPaymentBridge, WordPressPaymentBridgeError } from "./wordpressPaymentBridge";

interface PaymentProcessorDeps {
  repo: PrismaJobsRepo;
  stripe: StripeGateway;
  wpBridge: WordPressPaymentBridge;
  logger: NdjsonLogger;
}

export async function processPaymentActionJob(job: PaymentActionJobRecord, deps: PaymentProcessorDeps): Promise<void> {
  const reqId = job.reqId ?? undefined;
  try {
    const currentIntent = await deps.stripe.retrievePaymentIntent(job.paymentIntentId);
    const finalIntent = await resolveIntentState(job, currentIntent, deps.stripe);

    if (job.wpPrescriptionId != null && job.wpPrescriptionId > 0) {
      await deps.wpBridge.syncAuthorizedIntent(job.wpPrescriptionId, {
        paymentIntentId: job.paymentIntentId,
        stripeStatus: finalIntent.status,
        amountCents: finalIntent.amount,
        currency: finalIntent.currency,
        eventType: job.kind === "payment.capture" ? "worker.capture.completed" : "worker.cancel.completed",
        reqId,
      });
    }

    await deps.repo.markPaymentActionDone({
      jobId: job.id,
      workerRef: job.workerRef ?? undefined,
      reqId,
      result: {
        status: finalIntent.status,
        amount: finalIntent.amount,
        currency: finalIntent.currency,
      },
    });

    deps.logger.info(
      "payment.job.done",
      {
        job_id: job.id,
        kind: job.kind,
        prescription_id: job.prescriptionId,
        wp_prescription_id: job.wpPrescriptionId,
        payment_intent_id: job.paymentIntentId,
        stripe_status: finalIntent.status,
      },
      reqId,
    );
  } catch (err: unknown) {
    const classification = classifyError(err, job);
    if (classification.retryable) {
      await deps.repo.requeuePaymentActionJob({
        jobId: job.id,
        workerRef: job.workerRef ?? undefined,
        reqId,
        delaySeconds: classification.delaySeconds,
        errorCode: classification.code,
        messageSafe: classification.message,
      });
      deps.logger.warning(
        "payment.job.requeued",
        {
          job_id: job.id,
          kind: job.kind,
          payment_intent_id: job.paymentIntentId,
          code: classification.code,
          delay_seconds: classification.delaySeconds,
        },
        reqId,
        err instanceof Error ? err : undefined,
      );
      return;
    }

    await deps.repo.markPaymentActionFailed({
      jobId: job.id,
      workerRef: job.workerRef ?? undefined,
      reqId,
      errorCode: classification.code,
      messageSafe: classification.message,
    });
    deps.logger.error(
      "payment.job.failed",
      {
        job_id: job.id,
        kind: job.kind,
        payment_intent_id: job.paymentIntentId,
        code: classification.code,
      },
      reqId,
      err instanceof Error ? err : undefined,
    );
  }
}

async function resolveIntentState(
  job: PaymentActionJobRecord,
  currentIntent: StripePaymentIntentRecord,
  stripe: StripeGateway,
): Promise<StripePaymentIntentRecord> {
  if (job.kind === "payment.capture") {
    if (currentIntent.status === "succeeded") {
      return currentIntent;
    }
    if (currentIntent.status === "requires_capture") {
      return stripe.capturePaymentIntent(job.paymentIntentId, `capture_${job.id}`);
    }
    if (currentIntent.status === "canceled") {
      throw new Error("PaymentIntent already canceled and cannot be captured.");
    }
    throw new StripeGatewayError(
      "ML_STRIPE_NOT_CAPTURABLE",
      `PaymentIntent is not capturable yet (${currentIntent.status || "unknown"}).`,
      true,
      null,
      { status: currentIntent.status },
    );
  }

  if (currentIntent.status === "canceled") {
    return currentIntent;
  }
  if (currentIntent.status === "succeeded") {
    throw new Error("PaymentIntent already captured and cannot be canceled.");
  }
  return stripe.cancelPaymentIntent(job.paymentIntentId, `cancel_${job.id}`);
}

function classifyError(err: unknown, job: PaymentActionJobRecord): {
  retryable: boolean;
  code: string;
  message: string;
  delaySeconds: number;
} {
  const attempts = Math.max(1, job.attempts);
  const delaySeconds = Math.min(300, Math.max(15, attempts * 30));

  if (err instanceof StripeGatewayError) {
    return {
      retryable: err.transient,
      code: err.code,
      message: safeMessage(err.message, job.kind),
      delaySeconds,
    };
  }

  if (err instanceof WordPressPaymentBridgeError) {
    return {
      retryable: err.transient,
      code: err.code,
      message: safeMessage(err.message, job.kind),
      delaySeconds,
    };
  }

  const message = err instanceof Error ? err.message : "Payment job failed";
  return {
    retryable: false,
    code: "ML_PAYMENT_JOB_FAILED",
    message: safeMessage(message, job.kind),
    delaySeconds,
  };
}

function safeMessage(message: string, kind: string): string {
  const normalized = String(message ?? "").trim() || `Payment job ${kind} failed.`;
  return normalized.length > 300 ? `${normalized.slice(0, 300)}…` : normalized;
}
