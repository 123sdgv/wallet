// The production Worker stays closed until the owner approves connecting Wallet.
export default {
  fetch() {
    return new Response(null, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  },
};
