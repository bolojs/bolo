import { Step } from 'gauge-ts';
import { nextTemplate } from '@bolojs/next-server';
import { currentPage } from './hooks';

/**
 * NextSteps - steps for the next-server (Next.js Pages Router) spec.
 * The container is mounted with the create-next-app Pages template exported
 * by @bolojs/next-server, and the runtime mounts NextDevServer at /__next/.
 */
export default class NextSteps {
  /**
   * Step: Mount the built-in create-next-app Pages template into the
   * container VFS via the page bridge.
   */
  @Step('I mount the next template files')
  async mountNextTemplate() {
    await currentPage.evaluate(
      t => (window as any).__browserbox.container.mount(t),
      JSON.parse(JSON.stringify(nextTemplate)),
    );
  }

  /**
   * Step: Open the Next app in a same-origin iframe under /__next/ (the SW
   * bridges in-scope requests to the NextDevServer onFetch) and wait until
   * the client-rendered page shows the expected text.
   */
  @Step('The next preview iframe shows <text>')
  async nextPreviewShows(text: string) {
    await currentPage.evaluate(() => {
      let iframe = document.getElementById('bolo-next-preview') as HTMLIFrameElement | null;
      if (!iframe) {
        iframe = document.createElement('iframe');
        iframe.id = 'bolo-next-preview';
        iframe.src = '/__next/';
        iframe.style.cssText = 'width: 1024px; height: 768px;';
        document.body.appendChild(iframe);
      }
    });
    await currentPage.waitForFunction(
      t => {
        const iframe = document.getElementById('bolo-next-preview') as HTMLIFrameElement | null;
        return iframe?.contentDocument?.body?.innerText?.includes(t) ?? false;
      },
      text,
      { timeout: 30000 },
    );
  }
}
