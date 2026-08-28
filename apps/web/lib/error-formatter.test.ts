import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from './api';
import { formatApiError, isTechnicalErrorMessage } from './error-formatter';

describe('Issue #1067 — User-friendly error formatting and technical fallbacks', () => {
  it('rewords known backend error messages into plain language', () => {
    const err1 = new ApiError(403, 'only importer accounts can register');
    const formatted1 = formatApiError(err1);
    assert.equal(
      formatted1.userMessage,
      'Only registered importer accounts can perform this action.'
    );
    assert.equal(formatted1.rawMessage, 'only importer accounts can register');
    assert.equal(formatted1.isTechnical, false);

    const err2 = new ApiError(
      400,
      'HTS rate validation failed: one or more line items are underreported'
    );
    const formatted2 = formatApiError(err2);
    assert.equal(
      formatted2.userMessage,
      'Tariff data validation failed: one or more HTS rates appear to be underreported.'
    );

    const err3 = new ApiError(403, 'Importer failed OFAC sanctions screening');
    const formatted3 = formatApiError(err3);
    assert.equal(
      formatted3.userMessage,
      'Registration could not be completed because compliance screening requirements were not met.'
    );

    const err4 = new ApiError(400, 'withdraw amount exceeds available excess collateral');
    const formatted4 = formatApiError(err4);
    assert.equal(
      formatted4.userMessage,
      'The requested withdrawal amount exceeds your available excess collateral.'
    );
  });

  it('translates technical SQL/HTTP errors into safe generic fallbacks', () => {
    const rawSql = new Error('duplicate key value violates unique constraint "importers_ein_key"');
    const formattedSql = formatApiError(rawSql);
    assert.equal(
      formattedSql.userMessage,
      'An unexpected system error occurred. Please try again or contact support if the issue persists.'
    );
    assert.equal(
      formattedSql.rawMessage,
      'duplicate key value violates unique constraint "importers_ein_key"'
    );
    assert.equal(formattedSql.isTechnical, true);

    const rawConn = new Error('connect ECONNREFUSED 127.0.0.1:5432');
    const formattedConn = formatApiError(rawConn);
    assert.equal(formattedConn.isTechnical, true);
    assert.equal(
      formattedConn.userMessage,
      'An unexpected system error occurred. Please try again or contact support if the issue persists.'
    );
  });

  it('detects technical error messages correctly', () => {
    assert.equal(isTechnicalErrorMessage('HTTP 500 Internal Server Error'), true);
    assert.equal(isTechnicalErrorMessage('pg_query_params: null value in column'), true);
    assert.equal(isTechnicalErrorMessage('Please enter a valid amount'), false);
  });
});

describe('Issue #1068 — Tiered error banner severity', () => {
  it('tags recoverable validation/input errors as warning', () => {
    const insufficientFunds = new ApiError(400, 'insufficient collateral balance');
    assert.equal(formatApiError(insufficientFunds).severity, 'warning');

    const exceedsExcess = new ApiError(400, 'withdraw amount exceeds available excess collateral');
    assert.equal(formatApiError(exceedsExcess).severity, 'warning');

    const htsValidation = new ApiError(
      400,
      'HTS rate validation failed: one or more line items are underreported'
    );
    assert.equal(formatApiError(htsValidation).severity, 'warning');

    const invalidInput = new ApiError(400, 'invalid input: amount must be positive');
    assert.equal(formatApiError(invalidInput).severity, 'warning');
  });

  it('tags business-rule rejections and compliance failures as danger', () => {
    const sanctions = new ApiError(403, 'Importer failed OFAC sanctions screening');
    assert.equal(formatApiError(sanctions).severity, 'danger');

    const alreadyRegistered = new ApiError(409, 'importer already registered');
    assert.equal(formatApiError(alreadyRegistered).severity, 'danger');

    const kyc = new ApiError(403, 'KYC approval required');
    assert.equal(formatApiError(kyc).severity, 'danger');
  });

  it('tags technical/system failures as danger', () => {
    const rawSql = new Error('duplicate key value violates unique constraint "importers_ein_key"');
    assert.equal(formatApiError(rawSql).severity, 'danger');

    const rawConn = new Error('connect ECONNREFUSED 127.0.0.1:5432');
    assert.equal(formatApiError(rawConn).severity, 'danger');
  });

  it('defaults unclassified errors to danger as the safer fallback', () => {
    const unknown = new Error('something unexpected happened');
    assert.equal(formatApiError(unknown).severity, 'danger');
  });

  it('passes through an already-formatted error unchanged, including its severity', () => {
    const already = {
      userMessage: 'Custom message',
      rawMessage: 'raw',
      isTechnical: false,
      severity: 'warning' as const,
    };
    assert.deepEqual(formatApiError(already), already);
  });
});
