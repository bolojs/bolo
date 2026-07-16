const config = {
  use: {
    baseURL: process.env.DEMO_URL ?? 'http://localhost:4321/e2e/',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { viewport: { width: 1280, height: 720 } } }],
};

export default config;
