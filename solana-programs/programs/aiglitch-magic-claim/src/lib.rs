use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcmtkgHYTKY35");

pub const CLAIM_ID_LEN: usize = 16;

#[program]
pub mod aiglitch_magic_claim {
    use super::*;

    pub fn create_deposit(
        ctx: Context<CreateDeposit>,
        claim_id: [u8; CLAIM_ID_LEN],
        amount: u64,
        expires_at: i64,
    ) -> Result<()> {
        require!(amount > 0, MagicClaimError::ZeroAmount);
        let clock = Clock::get()?;
        require!(expires_at > clock.unix_timestamp, MagicClaimError::ExpiryInPast);

        let claim = &mut ctx.accounts.claim;
        claim.bump = ctx.bumps.claim;
        claim.claim_id = claim_id;
        claim.sender = ctx.accounts.sender.key();
        claim.mint = ctx.accounts.mint.key();
        claim.amount = amount;
        claim.expires_at = expires_at;
        claim.status = ClaimStatus::Pending as u8;

        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.sender_token_account.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault_token_account.to_account_info(),
                    authority: ctx.accounts.sender.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        Ok(())
    }

    pub fn claim(ctx: Context<ClaimTokens>) -> Result<()> {
        require!(
            ctx.accounts.claim.status == ClaimStatus::Pending as u8,
            MagicClaimError::NotPending
        );
        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp <= ctx.accounts.claim.expires_at,
            MagicClaimError::Expired
        );

        let claim_id = ctx.accounts.claim.claim_id;
        let bump = ctx.accounts.claim.bump;
        let seeds = &[b"claim".as_ref(), claim_id.as_ref(), &[bump]];
        let signer = &[&seeds[..]];

        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault_token_account.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.recipient_token_account.to_account_info(),
                    authority: ctx.accounts.claim.to_account_info(),
                },
                signer,
            ),
            ctx.accounts.claim.amount,
            ctx.accounts.mint.decimals,
        )?;

        ctx.accounts.claim.status = ClaimStatus::Claimed as u8;
        Ok(())
    }

    pub fn refund(ctx: Context<RefundTokens>) -> Result<()> {
        require!(
            ctx.accounts.claim.status == ClaimStatus::Pending as u8,
            MagicClaimError::NotPending
        );
        require_keys_eq!(
            ctx.accounts.claim.sender,
            ctx.accounts.sender.key(),
            MagicClaimError::NotSender
        );

        let claim_id = ctx.accounts.claim.claim_id;
        let bump = ctx.accounts.claim.bump;
        let seeds = &[b"claim".as_ref(), claim_id.as_ref(), &[bump]];
        let signer = &[&seeds[..]];

        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault_token_account.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.sender_token_account.to_account_info(),
                    authority: ctx.accounts.claim.to_account_info(),
                },
                signer,
            ),
            ctx.accounts.claim.amount,
            ctx.accounts.mint.decimals,
        )?;

        ctx.accounts.claim.status = ClaimStatus::Refunded as u8;
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(claim_id: [u8; CLAIM_ID_LEN])]
pub struct CreateDeposit<'info> {
    #[account(mut)]
    pub sender: Signer<'info>,

    #[account(
        init,
        payer = sender,
        space = 8 + Claim::INIT_SPACE,
        seeds = [b"claim", claim_id.as_ref()],
        bump,
    )]
    pub claim: Account<'info, Claim>,

    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = sender_token_account.owner == sender.key(),
        constraint = sender_token_account.mint == mint.key(),
    )]
    pub sender_token_account: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = sender,
        associated_token::mint = mint,
        associated_token::authority = claim,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimTokens<'info> {
    #[account(mut)]
    pub recipient: Signer<'info>,

    #[account(
        mut,
        seeds = [b"claim", claim.claim_id.as_ref()],
        bump = claim.bump,
    )]
    pub claim: Account<'info, Claim>,

    #[account(address = claim.mint)]
    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = claim,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = recipient,
        associated_token::mint = mint,
        associated_token::authority = recipient,
    )]
    pub recipient_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RefundTokens<'info> {
    #[account(mut)]
    pub sender: Signer<'info>,

    #[account(
        mut,
        seeds = [b"claim", claim.claim_id.as_ref()],
        bump = claim.bump,
    )]
    pub claim: Account<'info, Claim>,

    #[account(address = claim.mint)]
    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = claim,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = sender_token_account.owner == sender.key(),
        constraint = sender_token_account.mint == mint.key(),
    )]
    pub sender_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct Claim {
    pub bump: u8,
    pub claim_id: [u8; CLAIM_ID_LEN],
    pub sender: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub expires_at: i64,
    pub status: u8,
}

#[repr(u8)]
pub enum ClaimStatus {
    Pending = 0,
    Claimed = 1,
    Refunded = 2,
}

#[error_code]
pub enum MagicClaimError {
    #[msg("Amount must be > 0")]
    ZeroAmount,
    #[msg("Expiry must be in the future")]
    ExpiryInPast,
    #[msg("Claim is not pending")]
    NotPending,
    #[msg("Claim expired")]
    Expired,
    #[msg("Only original sender can refund")]
    NotSender,
}
