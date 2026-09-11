/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: false,
  // The board used to be Inditress-only at the root URL; keep old bookmarks working.
  async redirects() {
    return [{ source: '/', destination: '/inditress', permanent: false }];
  },
};
