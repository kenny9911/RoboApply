// WeChat Pay v3 notify fixture vectors (WP-62). TEST DATA ONLY.
//
// Generated once with node:crypto: a throwaway RSA-2048 "WeChat Pay public
// key" (its private half was discarded), a TRANSACTION.SUCCESS notify body
// whose resource is AEAD_AES_256_GCM-encrypted with a test APIv3 key, and the
// SHA256withRSA signature over "timestamp\nnonce\nbody\n" — the exact
// bytes WeChat Pay signs. No real merchant data.

export const NOTIFY_VECTOR = {
  "publicKey": "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAn58UW/y/SsjvFBXje5X9\nghk/5MjYAHrJ3KJ8tTE0CxkW5LWisWLSGL87cxfz44kB6cgJlanwYIRhiVPRw2pI\n9o748RgqJX9QZ0pXdGlPqkFkaPVObioPBQb3+spl+fOfGvfmprPefIqopghDHcE7\nRzEudpqK5FiBY4f2nuvNOQsRkTwfQC0Rv4cZ3WXXxrVt/0+7H8MXJnKcdZXM+nve\nnOXBPkklJJ7ddccO8KxjmYn7QbTuIOK+iig8qgkKJ77KLteL2Htdy2t1jvdcCb6/\n2I1JzkD5Bl9l/4isB56GbdUmno0/KHlEs/G2eNx91fKpRpHniMzEINKDfKLF7yK1\niwIDAQAB\n-----END PUBLIC KEY-----\n",
  "publicKeyId": "PUB_KEY_ID_0119000000012026101000000000000001",
  "apiV3Key": "GoApplyTestApiV3Key0123456789abc",
  "headers": {
    "wechatpay-timestamp": "1791590465",
    "wechatpay-nonce": "notifyNonce42",
    "wechatpay-signature": "Nd5ZhrLW3AO6oRvcNnpxBJmVrU3ZVeo7w/v2uaFeBYWXACph57M5MsLz2J/XHDvVzMWXQrQ55LwoCcGOCUUuLtpsetz9BAO5SzUwHfBQt7oCrrwnh3/BfSmdeYA4JV6KgxxxGsqZfQ+0V5nPqrImPi/1eS2auYCPyB8alIFN8IeFzDz8XrelP3Hdrn+TJHnIxrgPEECKHsW2xZKEpjEM+RCGFAcPCdabDWSt+vChB0kSoNk6JobM0ZvzR4ycSvLRz/lfPvGiwChhfZKnqRM+xfd1rFVkmP3SKCxELhIJwlG0E2nhcPXvDEinO4Zxn1Na0WShhM9/HZRqJ9tPblVX+w==",
    "wechatpay-serial": "PUB_KEY_ID_0119000000012026101000000000000001",
    "wechatpay-signature-type": "WECHATPAY2-SHA256-RSA2048"
  }
} as const;

/** The raw notify body, byte for byte (any change breaks the signature). */
export const NOTIFY_BODY = "{\"id\":\"EV-2026101008010000001\",\"create_time\":\"2026-10-10T16:01:05+08:00\",\"resource_type\":\"encrypt-resource\",\"event_type\":\"TRANSACTION.SUCCESS\",\"summary\":\"支付成功\",\"resource\":{\"original_type\":\"transaction\",\"algorithm\":\"AEAD_AES_256_GCM\",\"ciphertext\":\"IYuC5yT36DDpEXp/njLRXAH+lTH5Y7NpNf+ERH24DzDEMT+zByZa5H5VGcYzztT3YSChxuYPrhjhRq+pKeDmnGNe2NBRo3ktG99fAnPPYM1DRYIHUxmOp5yH6EyjWXtmLimM5m/OQNXkfQ5qG266ISKk8vjdo2oolyUf+NBN/9KKZesOgvnmw/tKDAcP/T1rhjhEangQ/xVOcBWi0U4sura0y6yvkAI4vGyEtTRPAJKUPElhMIlYYGGXjSzF1Q02kHVD6F/wlR1+GW+x2SdfMWIoaIUSgqcjP4kx/dFLaa+IduVqYWuvGQ/SMozcdsxt70UUiFqnT/mVf+i1Gnjne1N57tRwgWPq0h5alqU2pzq0r4v/OMwpd1sy+dpC+U/BrZ1oF3iuLH4Lkw1Srwp2b+zB253PLpP5/kTW/vXe4jDlAawTWwS42Jd/1ypahsnn26ZiAmf5pAzJYCH7S/SGftG392B6l/yVRI1PXKInsxN527demMIe7lHYk36YQp7iMj9mHEaQ8FDSTqhX4Qbext8byl02E4y1QUXbIFiWdlbQbuqXmvJGvj4K5Ue2TWxDk+xTIzRru7FOQ1+LBYjMvvw7\",\"associated_data\":\"transaction\",\"nonce\":\"fixtureNonce\"}}";

/** What the encrypted resource decrypts to. */
export const NOTIFY_TRANSACTION = {
  "mchid": "1900000001",
  "appid": "wxtestappid000001",
  "out_trade_no": "GAWX20261010080000a1b2c3d4e5f6",
  "transaction_id": "4200000000202610100000000001",
  "trade_type": "NATIVE",
  "trade_state": "SUCCESS",
  "trade_state_desc": "支付成功",
  "bank_type": "OTHERS",
  "attach": "plan=pro_monthly",
  "success_time": "2026-10-10T16:01:00+08:00",
  "payer": {
    "openid": "oTestOpenId"
  },
  "amount": {
    "total": 3900,
    "payer_total": 3900,
    "currency": "CNY",
    "payer_currency": "CNY"
  }
} as const;

/** Seconds since the epoch the vector was signed at. */
export const NOTIFY_SIGNED_AT_SEC = 1791590465;
