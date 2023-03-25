const { HATCH_PERIOD, HATCH_STATE, HATCH_MAX_GOAL, HATCH_MIN_GOAL } = require('./helpers/constants')
const { contributionToProjectTokens, getEvent, now } = require('./common/utils')
const { prepareDefaultSetup, defaultDeployParams, initializeHatch } = require('./common/deploy')
const { assertRevert, assertBn } = require('@1hive/contract-helpers-test/src/asserts')
const { bn } = require('@1hive/contract-helpers-test/src/numbers')

const BUYER_BALANCE = 1000

contract('Hatch, refund() functionality', ([anyone, appManager, buyer1, buyer2, buyer3, buyer4, buyer5, buyer6]) => {
  const itAllowsBuyersToGetRefunded = startDate => {
    before(async () => {
      await prepareDefaultSetup(this, appManager)
      await initializeHatch(this, { ...defaultDeployParams(this, appManager), startDate })

      await this.contributionToken.generateTokens(buyer1, BUYER_BALANCE)
      await this.contributionToken.generateTokens(buyer2, BUYER_BALANCE)
      await this.contributionToken.generateTokens(buyer3, BUYER_BALANCE)
      await this.contributionToken.generateTokens(buyer5, BUYER_BALANCE)
      await this.contributionToken.generateTokens(buyer6, BUYER_BALANCE)

      await this.contributionToken.approve(this.hatch.address, BUYER_BALANCE, { from: buyer1 })
      await this.contributionToken.approve(this.hatch.address, BUYER_BALANCE, { from: buyer2 })
      await this.contributionToken.approve(this.hatch.address, BUYER_BALANCE, { from: buyer3 })
      await this.contributionToken.approve(this.hatch.address, BUYER_BALANCE, { from: buyer5 })
      await this.contributionToken.approve(this.hatch.address, BUYER_BALANCE, { from: buyer6 })

      if (startDate == 0) {
        startDate = now()
        await this.hatch.open({ from: appManager })
      }
      this.hatch.mockSetTimestamp(startDate + 1)
    })

    describe('When purchases have been made and the sale is Refunding', () => {
      before(async () => {
        // Make a few purchases, careful not to reach the funding goal.
        await this.hatch.contribute(BUYER_BALANCE, { from: buyer1 }) // Spends everything in one purchase
        await this.hatch.contribute(BUYER_BALANCE / 2, { from: buyer2 })
        await this.hatch.contribute(BUYER_BALANCE / 2, { from: buyer2 }) // Spends everything in two purchases
        await this.hatch.contribute(BUYER_BALANCE / 2, { from: buyer3 }) // Spends half
        await this.hatch.contribute(1, { from: buyer5 }) // Spends a miserable amount xD
        await this.hatch.contribute(1, { from: buyer5 }) // And again
        await this.hatch.contribute(1, { from: buyer6 })

        this.hatch.mockSetTimestamp(startDate + HATCH_PERIOD + 1)
      })

      it('Sale state is Refunding', async () => {
        assert.equal((await this.hatch.state()).toNumber(), HATCH_STATE.REFUNDING)
      })

      it('Buyers obtained project tokens for their contribution tokens', async () => {
        assertBn(await this.contributionToken.balanceOf(buyer1), bn(0))
        assertBn(await this.contributionToken.balanceOf(buyer2), bn(0))
        assertBn(await this.contributionToken.balanceOf(buyer3), bn(BUYER_BALANCE / 2))

        assertBn(await this.projectToken.balanceOf(buyer1), contributionToProjectTokens(bn(BUYER_BALANCE)))
        assertBn(await this.projectToken.balanceOf(buyer2), contributionToProjectTokens(bn(BUYER_BALANCE)))
        assertBn(await this.projectToken.balanceOf(buyer3), contributionToProjectTokens(bn(BUYER_BALANCE / 2)))
      })

      it('Allows a buyer who made a single purchase to get refunded', async () => {
        await this.hatch.refund(buyer1)
        assertBn(await this.contributionToken.balanceOf(buyer1), bn(BUYER_BALANCE))
        assertBn(await this.projectToken.balanceOf(buyer1), bn(0))
      })

      it('Allows a buyer who made multiple purchases to get refunded', async () => {
        await this.hatch.refund(buyer2)
        assertBn(await this.contributionToken.balanceOf(buyer2), bn(BUYER_BALANCE))
      })

      it('A Refund event is emitted', async () => {
        const refundTx = await this.hatch.refund(buyer5)
        const expectedAmount = contributionToProjectTokens(bn(2))
        const event = getEvent(refundTx, 'Refund')
        assert.equal(event.args.contributor, buyer5)
        assert.equal(event.args.value.toNumber(), bn(2))
        assertBn(event.args.amount, expectedAmount)
      })

      it('Project tokens are burnt once refunded', async () => {
        const expectedAmount = contributionToProjectTokens(bn(1))
        const initialProjectTokenSupply = bn(await this.projectToken.totalSupply())
        await this.hatch.refund(buyer6)
        assertBn(await this.projectToken.totalSupply(), initialProjectTokenSupply.sub(expectedAmount))
      })

      it("Should deny anyone to get a refund for a purchase that wasn't made", async () => {
        await assertRevert(this.hatch.refund(anyone), 'HATCH_NOTHING_TO_REFUND')
      })

      it("Should deny a buyer to get a refund for a purchase that wasn't made", async () => {
        await assertRevert(this.hatch.refund(buyer2), 'HATCH_NOTHING_TO_REFUND')
      })
    })

    describe('When purchases have been made and the sale is Funding', () => {
      before(async () => {
        this.hatch.mockSetTimestamp(startDate)
      })

      it('Sale state is Funding', async () => {
        assert.equal((await this.hatch.state()).toNumber(), HATCH_STATE.FUNDING)
      })

      it('Should revert if a buyer attempts to get a refund', async () => {
        await assertRevert(this.hatch.refund(buyer1), 'HATCH_INVALID_STATE')
      })
    })

    describe('When purchases have been made and the sale is ready to be closed', () => {
      before(async () => {
        this.hatch.mockSetTimestamp(startDate)
        await this.contributionToken.generateTokens(buyer4, HATCH_MAX_GOAL)
        await this.contributionToken.approve(this.hatch.address, HATCH_MAX_GOAL, { from: buyer4 })

        const leftToMinGoal = bn(HATCH_MIN_GOAL).sub(bn(await this.hatch.totalRaised()))
        await this.hatch.contribute(leftToMinGoal, { from: buyer4 })
      })

      it('Sale state is Funding if period has not ended', async () => {
        assert.equal((await this.hatch.state()).toNumber(), HATCH_STATE.FUNDING)
      })

      it('Should revert if a buyer attempts to get a refund', async () => {
        await assertRevert(this.hatch.refund(buyer4), 'HATCH_INVALID_STATE')
      })

      describe('When min goal is reached and period has ended', async () => {
        before(async () => {
          this.hatch.mockSetTimestamp(startDate + HATCH_PERIOD + 1)
        })
  
        it('Sale state is GoalReached', async () => {
          assert.equal((await this.hatch.state()).toNumber(), HATCH_STATE.GOAL_REACHED)
        })
  
        it('Should revert if a buyer attempts to get a refund', async () => {
          await assertRevert(this.hatch.refund(buyer4), 'HATCH_INVALID_STATE')
        })
      })
    })
  }

  describe('When no startDate is specified upon initialization', () => {
    itAllowsBuyersToGetRefunded(0)
  })

  describe('When a startDate is specified upon initialization', () => {
    itAllowsBuyersToGetRefunded(now() + 3600)
  })
})
