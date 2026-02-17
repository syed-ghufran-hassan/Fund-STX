import { Cl, cvToValue, signMessageHashRsv } from "@stacks/transactions";
import { beforeEach, describe, expect, it } from "vitest";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const creator = accounts.get("wallet_1")!;
const contributor1 = accounts.get("wallet_2")!;
const contributor2 = accounts.get("wallet_3")!;
const contributor3 = accounts.get("wallet_4")!;
const randomUser = accounts.get("wallet_5")!;

// Mock USDCx token contract (sip-010 compliant)
const mockTokenAddress = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.mock-token";

describe("Crowdfunding Campaign Contract", () => {
  let campaignId: number;

  describe("Campaign Creation", () => {
    it("should allow anyone to create a campaign", () => {
      const title = "Save the Rainforest";
      const goal = 1000;
      const deadline = 500; // block height

      const result = simnet.callPublicFn(
        "campaign",
        "create-campaign",
        [
          Cl.stringUtf8(title),
          Cl.uint(goal),
          Cl.uint(deadline)
        ],
        creator
      );

      expect(result.result).toBeOk(Cl.uint(1));
      
      const campaign = simnet.getMapEntry("campaign", "campaigns", Cl.uint(1));
      expect(campaign).toBeSome(
        Cl.tuple({
          creator: Cl.principal(creator),
          title: Cl.stringUtf8(title),
          goal: Cl.uint(goal),
          deadline: Cl.uint(deadline),
          raised: Cl.uint(0),
          claimed: Cl.bool(false)
        })
      );

      campaignId = 1;
    });

    it("should increment campaign nonce", () => {
      const nonce = simnet.getDataVar("campaign", "campaign-nonce");
      expect(nonce).toBeUint(1);
    });

    it("should create multiple campaigns", () => {
      const result = simnet.callPublicFn(
        "campaign",
        "create-campaign",
        [
          Cl.stringUtf8("Second Campaign"),
          Cl.uint(500),
          Cl.uint(600)
        ],
        creator
      );

      expect(result.result).toBeOk(Cl.uint(2));
      
      const nonce = simnet.getDataVar("campaign", "campaign-nonce");
      expect(nonce).toBeUint(2);
    });
  });

  describe("Contributions", () => {
    beforeEach(() => {
      // Create a fresh campaign for each test
      const result = simnet.callPublicFn(
        "campaign",
        "create-campaign",
        [
          Cl.stringUtf8("Test Campaign"),
          Cl.uint(1000),
          Cl.uint(500) // deadline far in future
        ],
        creator
      );
      campaignId = (result.result as any).value.value;
    });

    it("should allow contributions with valid amount", () => {
      const contributeAmount = 100;

      // Mock token transfer
      const contribute = simnet.callPublicFn(
        "campaign",
        "contribute",
        [
          Cl.uint(campaignId),
          Cl.uint(contributeAmount),
          Cl.principal(mockTokenAddress)
        ],
        contributor1
      );

      expect(contribute.result).toBeOk(Cl.bool(true));

      // Check campaign raised amount
      const campaign = simnet.getMapEntry("campaign", "campaigns", Cl.uint(campaignId));
      expect(campaign.value.data.raised).toBeUint(contributeAmount);

      // Check contribution mapping
      const contribution = simnet.getMapEntry(
        "campaign",
        "contributions",
        Cl.tuple({
          "campaign-id": Cl.uint(campaignId),
          contributor: Cl.principal(contributor1)
        })
      );
      expect(contribution).toBeSome(Cl.uint(contributeAmount));
    });

    it("should accumulate multiple contributions", () => {
      // First contribution
      simnet.callPublicFn(
        "campaign",
        "contribute",
        [Cl.uint(campaignId), Cl.uint(200), Cl.principal(mockTokenAddress)],
        contributor1
      );

      // Second contribution
      simnet.callPublicFn(
        "campaign",
        "contribute",
        [Cl.uint(campaignId), Cl.uint(300), Cl.principal(mockTokenAddress)],
        contributor2
      );

      const campaign = simnet.getMapEntry("campaign", "campaigns", Cl.uint(campaignId));
      expect(campaign.value.data.raised).toBeUint(500);
    });

    it("should allow same contributor to contribute multiple times", () => {
      // First contribution
      simnet.callPublicFn(
        "campaign",
        "contribute",
        [Cl.uint(campaignId), Cl.uint(100), Cl.principal(mockTokenAddress)],
        contributor1
      );

      // Second contribution
      simnet.callPublicFn(
        "campaign",
        "contribute",
        [Cl.uint(campaignId), Cl.uint(150), Cl.principal(mockTokenAddress)],
        contributor1
      );

      const contribution = simnet.getMapEntry(
        "campaign",
        "contributions",
        Cl.tuple({
          "campaign-id": Cl.uint(campaignId),
          contributor: Cl.principal(contributor1)
        })
      );
      expect(contribution).toBeSome(Cl.uint(250));
    });

    it("should reject contributions after deadline", () => {
      // Advance blocks past deadline
      simnet.mineEmptyBlocks(600);

      const contribute = simnet.callPublicFn(
        "campaign",
        "contribute",
        [Cl.uint(campaignId), Cl.uint(100), Cl.principal(mockTokenAddress)],
        contributor1
      );

      expect(contribute.result).toBeErr(Cl.uint(104)); // ERR-DEADLINE-PASSED
    });

    it("should reject zero amount contributions", () => {
      const contribute = simnet.callPublicFn(
        "campaign",
        "contribute",
        [Cl.uint(campaignId), Cl.uint(0), Cl.principal(mockTokenAddress)],
        contributor1
      );

      expect(contribute.result).toBeErr(Cl.uint(106)); // ERR-INVALID-AMOUNT
    });

    it("should reject contributions to non-existent campaign", () => {
      const contribute = simnet.callPublicFn(
        "campaign",
        "contribute",
        [Cl.uint(999), Cl.uint(100), Cl.principal(mockTokenAddress)],
        contributor1
      );

      expect(contribute.result).toBeErr(Cl.uint(101)); // ERR-CAMPAIGN-NOT-FOUND
    });
  });

  describe("Claim Funds", () => {
    beforeEach(() => {
      // Create campaign with goal 1000
      const result = simnet.callPublicFn(
        "campaign",
        "create-campaign",
        [
          Cl.stringUtf8("Claim Test"),
          Cl.uint(1000),
          Cl.uint(500)
        ],
        creator
      );
      campaignId = (result.result as any).value.value;

      // Add contributions to meet goal
      simnet.callPublicFn(
        "campaign",
        "contribute",
        [Cl.uint(campaignId), Cl.uint(600), Cl.principal(mockTokenAddress)],
        contributor1
      );

      simnet.callPublicFn(
        "campaign",
        "contribute",
        [Cl.uint(campaignId), Cl.uint(400), Cl.principal(mockTokenAddress)],
        contributor2
      );
    });

    it("should allow creator to claim funds when goal is met", () => {
      const claim = simnet.callPublicFn(
        "campaign",
        "claim-funds",
        [Cl.uint(campaignId), Cl.principal(mockTokenAddress)],
        creator
      );

      expect(claim.result).toBeOk(Cl.bool(true));

      // Check campaign marked as claimed
      const campaign = simnet.getMapEntry("campaign", "campaigns", Cl.uint(campaignId));
      expect(campaign.value.data.claimed).toBe(Cl.bool(true));

      // Check transfer event
      expect(claim.events[0].event).toBe("ft_transfer_event");
      expect(claim.events[0].data.amount).toBe("1000");
      expect(claim.events[0].data.recipient).toBe(creator);
    });

    it("should not allow non-creator to claim funds", () => {
      const claim = simnet.callPublicFn(
        "campaign",
        "claim-funds",
        [Cl.uint(campaignId), Cl.principal(mockTokenAddress)],
        contributor1
      );

      expect(claim.result).toBeErr(Cl.uint(100)); // ERR-NOT-AUTHORIZED
    });

    it("should not allow claiming if goal not met", () => {
      // Create new campaign with insufficient funds
      const newCampaign = simnet.callPublicFn(
        "campaign",
        "create-campaign",
        [
          Cl.stringUtf8("Low Funds"),
          Cl.uint(1000),
          Cl.uint(500)
        ],
        creator
      );
      const lowCampaignId = (newCampaign.result as any).value.value;

      // Add small contribution
      simnet.callPublicFn(
        "campaign",
        "contribute",
        [Cl.uint(lowCampaignId), Cl.uint(500), Cl.principal(mockTokenAddress)],
        contributor1
      );

      const claim = simnet.callPublicFn(
        "campaign",
        "claim-funds",
        [Cl.uint(lowCampaignId), Cl.principal(mockTokenAddress)],
        creator
      );

      expect(claim.result).toBeErr(Cl.uint(102)); // ERR-GOAL-NOT-MET
    });

    it("should not allow claiming twice", () => {
      // First claim
      simnet.callPublicFn(
        "campaign",
        "claim-funds",
        [Cl.uint(campaignId), Cl.principal(mockTokenAddress)],
        creator
      );

      // Second claim attempt
      const secondClaim = simnet.callPublicFn(
        "campaign",
        "claim-funds",
        [Cl.uint(campaignId), Cl.principal(mockTokenAddress)],
        creator
      );

      expect(secondClaim.result).toBeErr(Cl.uint(103)); // ERR-ALREADY-CLAIMED
    });
  });

  describe("Refunds", () => {
    beforeEach(() => {
      // Create campaign with future deadline
      const currentBlock = simnet.blockHeight;
      const result = simnet.callPublicFn(
        "campaign",
        "create-campaign",
        [
          Cl.stringUtf8("Refund Test"),
          Cl.uint(1000),
          Cl.uint(currentBlock + 10)
        ],
        creator
      );
      campaignId = (result.result as any).value.value;

      // Add contributions (not meeting goal)
      simnet.callPublicFn(
        "campaign",
        "contribute",
        [Cl.uint(campaignId), Cl.uint(300), Cl.principal(mockTokenAddress)],
        contributor1
      );

      simnet.callPublicFn(
        "campaign",
        "contribute",
        [Cl.uint(campaignId), Cl.uint(200), Cl.principal(mockTokenAddress)],
        contributor2
      );
    });

    it("should allow contributors to get refunds after deadline if goal not met", () => {
      // Advance past deadline
      simnet.mineEmptyBlocks(15);

      const refund = simnet.callPublicFn(
        "campaign",
        "refund",
        [Cl.uint(campaignId), Cl.principal(mockTokenAddress)],
        contributor1
      );

      expect(refund.result).toBeOk(Cl.bool(true));

      // Check contribution reset to 0
      const contribution = simnet.getMapEntry(
        "campaign",
        "contributions",
        Cl.tuple({
          "campaign-id": Cl.uint(campaignId),
          contributor: Cl.principal(contributor1)
        })
      );
      expect(contribution).toBeSome(Cl.uint(0));

      // Check transfer event
      expect(refund.events[0].event).toBe("ft_transfer_event");
      expect(refund.events[0].data.amount).toBe("300");
      expect(refund.events[0].data.recipient).toBe(contributor1);
    });

    it("should not allow refund before deadline", () => {
      const refund = simnet.callPublicFn(
        "campaign",
        "refund",
        [Cl.uint(campaignId), Cl.principal(mockTokenAddress)],
        contributor1
      );

      expect(refund.result).toBeErr(Cl.uint(105)); // ERR-DEADLINE-NOT-PASSED
    });

    it("should not allow refund if goal was met", () => {
      // Add more contributions to meet goal
      simnet.callPublicFn(
        "campaign",
        "contribute",
        [Cl.uint(campaignId), Cl.uint(500), Cl.principal(mockTokenAddress)],
        contributor3
      );

      // Advance past deadline
      simnet.mineEmptyBlocks(15);

      const refund = simnet.callPublicFn(
        "campaign",
        "refund",
        [Cl.uint(campaignId), Cl.principal(mockTokenAddress)],
        contributor1
      );

      expect(refund.result).toBeErr(Cl.uint(102)); // ERR-GOAL-NOT-MET
    });

    it("should allow multiple contributors to get refunds", () => {
      simnet.mineEmptyBlocks(15);

      // First contributor refund
      simnet.callPublicFn(
        "campaign",
        "refund",
        [Cl.uint(campaignId), Cl.principal(mockTokenAddress)],
        contributor1
      );

      // Second contributor refund
      const refund2 = simnet.callPublicFn(
        "campaign",
        "refund",
        [Cl.uint(campaignId), Cl.principal(mockTokenAddress)],
        contributor2
      );

      expect(refund2.result).toBeOk(Cl.bool(true));
      expect(refund2.events[0].data.amount).toBe("200");
    });

    it("should not allow refund for zero contribution", () => {
      simnet.mineEmptyBlocks(15);

      const refund = simnet.callPublicFn(
        "campaign",
        "refund",
        [Cl.uint(campaignId), Cl.principal(mockTokenAddress)],
        randomUser // Didn't contribute
      );

      expect(refund.result).toBeErr(Cl.uint(106)); // ERR-INVALID-AMOUNT
    });
  });

  describe("Read-only functions", () => {
    beforeEach(() => {
      const result = simnet.callPublicFn(
        "campaign",
        "create-campaign",
        [
          Cl.stringUtf8("Read Test"),
          Cl.uint(1000),
          Cl.uint(500)
        ],
        creator
      );
      campaignId = (result.result as any).value.value;

      // Add contribution
      simnet.callPublicFn(
        "campaign",
        "contribute",
        [Cl.uint(campaignId), Cl.uint(250), Cl.principal(mockTokenAddress)],
        contributor1
      );
    });

    it("should return correct campaign details", () => {
      const campaign = simnet.callReadOnlyFn(
        "campaign",
        "get-campaign",
        [Cl.uint(campaignId)],
        randomUser
      );

      expect(campaign.result).toBeSome(
        Cl.tuple({
          creator: Cl.principal(creator),
          title: Cl.stringUtf8("Read Test"),
          goal: Cl.uint(1000),
          deadline: Cl.uint(500),
          raised: Cl.uint(250),
          claimed: Cl.bool(false)
        })
      );
    });

    it("should return correct contribution amount", () => {
      const contribution = simnet.callReadOnlyFn(
        "campaign",
        "get-contribution",
        [Cl.uint(campaignId), Cl.principal(contributor1)],
        randomUser
      );

      expect(contribution.result).toBeUint(250);
    });

    it("should return 0 for non-contributors", () => {
      const contribution = simnet.callReadOnlyFn(
        "campaign",
        "get-contribution",
        [Cl.uint(campaignId), Cl.principal(randomUser)],
        randomUser
      );

      expect(contribution.result).toBeUint(0);
    });

    it("should return none for non-existent campaign", () => {
      const campaign = simnet.callReadOnlyFn(
        "campaign",
        "get-campaign",
        [Cl.uint(999)],
        randomUser
      );

      expect(campaign.result).toBeNone();
    });
  });

  describe("Edge Cases and Integration", () => {
    it("should handle campaign with zero goal", () => {
      const result = simnet.callPublicFn(
        "campaign",
        "create-campaign",
        [
          Cl.stringUtf8("Zero Goal"),
          Cl.uint(0),
          Cl.uint(500)
        ],
        creator
      );

      expect(result.result).toBeOk(Cl.uint(4));

      // Should be immediately claimable
      const claim = simnet.callPublicFn(
        "campaign",
        "claim-funds",
        [Cl.uint(4), Cl.principal(mockTokenAddress)],
        creator
      );

      expect(claim.result).toBeOk(Cl.bool(true));
    });

    it("should handle campaign with very long deadline", () => {
      const farFuture = 1000000;
      const result = simnet.callPublicFn(
        "campaign",
        "create-campaign",
        [
          Cl.stringUtf8("Long Campaign"),
          Cl.uint(1000),
          Cl.uint(farFuture)
        ],
        creator
      );

      expect(result.result).toBeOk(Cl.uint(5));
    });

    it("should handle many small contributions", () => {
      const result = simnet.callPublicFn(
        "campaign",
        "create-campaign",
        [
          Cl.stringUtf8("Micro Campaign"),
          Cl.uint(100),
          Cl.uint(500)
        ],
        creator
      );
      const microCampaignId = (result.result as any).value.value;

      // Make 10 small contributions
      for (let i = 0; i < 10; i++) {
        simnet.callPublicFn(
          "campaign",
          "contribute",
          [Cl.uint(microCampaignId), Cl.uint(10), Cl.principal(mockTokenAddress)],
          contributor1
        );
      }

      const campaign = simnet.getMapEntry("campaign", "campaigns", Cl.uint(microCampaignId));
      expect(campaign.value.data.raised).toBeUint(100);
    });

    it("should prevent claiming after refund period", () => {
      // Create campaign that doesn't meet goal
      const result = simnet.callPublicFn(
        "campaign",
        "create-campaign",
        [
          Cl.stringUtf8("Failed Campaign"),
          Cl.uint(1000),
          Cl.uint(500)
        ],
        creator
      );
      const failedId = (result.result as any).value.value;

      simnet.callPublicFn(
        "campaign",
        "contribute",
        [Cl.uint(failedId), Cl.uint(500), Cl.principal(mockTokenAddress)],
        contributor1
      );

      // Advance past deadline
      simnet.mineEmptyBlocks(600);

      // Try to claim (should fail)
      const claim = simnet.callPublicFn(
        "campaign",
        "claim-funds",
        [Cl.uint(failedId), Cl.principal(mockTokenAddress)],
        creator
      );

      expect(claim.result).toBeErr(Cl.uint(102)); // ERR-GOAL-NOT-MET

      // Refund should work
      const refund = simnet.callPublicFn(
        "campaign",
        "refund",
        [Cl.uint(failedId), Cl.principal(mockTokenAddress)],
        contributor1
      );

      expect(refund.result).toBeOk(Cl.bool(true));
    });
  });
});
