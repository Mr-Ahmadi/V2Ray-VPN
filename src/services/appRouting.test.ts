jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => '/tmp/test'),
  },
}));

import { AppRoutingService } from './appRouting';

describe('AppRoutingService capabilities', () => {
  const service = new AppRoutingService();

  test('detects Chromium capability as forceable for proxy and direct', () => {
    const capability = service.getAppRoutingCapability('/Applications/Google Chrome.app');
    expect(capability.engine).toBe('chromium');
    expect(capability.canForceProxy).toBe(true);
    expect(capability.canForceDirect).toBe(true);
  });

  test('marks Safari as capability-supported with best-effort direct routing', () => {
    const capability = service.getAppRoutingCapability('/Applications/Safari.app');
    expect(capability.engine).toBe('safari');
    expect(capability.canForceProxy).toBe(true);
    expect(capability.canForceDirect).toBe(true);
  });

  test('detects Telegram capability', () => {
    const capability = service.getAppRoutingCapability('/Applications/Telegram.app');
    expect(capability.engine).toBe('telegram');
    expect(capability.canForceProxy).toBe(true);
    expect(capability.canForceDirect).toBe(true);
  });
});
