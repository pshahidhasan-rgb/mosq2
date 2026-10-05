const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  
  await page.goto('http://localhost:3000/display.html?session=myo-youth-8f3a9e');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'display_test.png' });
  
  await page.goto('http://localhost:3000/admin.html?session=myo-youth-8f3a9e');
  await page.waitForTimeout(2000);
  
  // Click start
  await page.click('#btn-start');
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'admin_test.png' });
  
  await browser.close();
})();
