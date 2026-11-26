export class PaymentService {
  static attempts = 0;
  static successfulDeductions = 0;
  static mockResult = null;
  static mockHandler = null;

  static reset() {
    this.attempts = 0;
    this.successfulDeductions = 0;
    this.mockResult = null;
    this.mockHandler = null;
    this.getAccountSubscriptionValue = {
      plan: "FREE",
      status: "ACTIVE",
      expiryDate: null,
      isPaid: false,
    };
  }

  static getAccountSubscriptionValue = {
    plan: "FREE",
    status: "ACTIVE",
    expiryDate: null,
    isPaid: false,
  };

  static async getAccountSubscription() {
    return this.getAccountSubscriptionValue;
  }

  static async deductAiCredit(userId, amount = 1, reason = "nova_chat") {
    this.attempts += 1;
    if (this.mockHandler) {
      const res = await this.mockHandler({ userId, amount, reason, attempt: this.attempts });
      if (res?.success) {
        this.successfulDeductions += 1;
      }
      return res;
    }
    const result = this.mockResult || { success: true, remainingCredits: 10 };
    if (result.success) {
      this.successfulDeductions += 1;
    }
    return result;
  }
}
