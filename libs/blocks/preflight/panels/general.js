import { html, signal, useEffect } from '../../../deps/htm-preact.js';
import { STATUS, STRUCTURE_TITLES } from '../checks/constants.js';
import { runChecks as runStructureChecks } from '../checks/structure.js';
import userCanPublishPage from '../../../tools/utils/publish.js';
import getServiceConfig from '../../../utils/service-config.js';

// Add these constants
const SPIDY_URL_FALLBACK = 'https://spidy.gwp.corp.adobe.com';
const DEF_NOT_FOUND = 'Not found';
const DEF_NEVER = 'Never';
const NOT_FOUND = {
  preview: { lastModified: DEF_NOT_FOUND },
  live: { lastModified: DEF_NOT_FOUND },
};
const DA_DOMAIN = 'da.live';
const nonEDSContent = 'Non AEM EDS Content';
const EXCLUDED_PATHS = ['/tools/caas'];

const brokenLinksData = signal({ links: [], loading: false });

// Add these helper functions before getStructureResults
export function makeGroups(arr, n = 20) {
  const batchSize = Math.ceil(arr.length / n);
  const size = Math.ceil(arr.length / batchSize);
  return Array.from({ length: batchSize }, (v, i) => arr.slice(i * size, i * size + size));
}

export async function spidyCheck(url) {
  try {
    const resp = await fetch(url, { method: 'HEAD' });
    return !!resp.ok;
  } catch (e) {
    return false;
  }
}

export async function getSpidyResults(url, opts) {
  try {
    const resp = await fetch(`${url}/api/url-http-status`, opts);
    if (!resp.ok) return [];
    
    const json = await resp.json();
    if (!json.data || json.data.length === 0) return [];
    
    return json.data.reduce((acc, result) => {
      const status = result.status === 'ECONNREFUSED' ? 503 : result.status;
      if (status >= 399) {
        result.status = status;
        acc.push(result);
      }
      return acc;
    }, []);
  } catch (e) {
    return [];
  }
}

export function getLocaleFromUrl(url) {
  // Extract locale from URL path like /en_us/, /jp/, /fr/, etc.
  const pathMatch = url.pathname.match(/^\/([a-z]{2}(?:_[a-z]{2})?)\//i);
  return pathMatch ? pathMatch[1] : 'en_us';
}

export function getTagType(element) {
  const tagName = element.tagName.toLowerCase();
  if (tagName === 'a') return 'Anchor';
  if (tagName === 'img') return 'Image';
  if (tagName === 'iframe') return 'iFrame';
  return tagName;
}

export function getPosition(element) {
  if (element.closest('nav') || element.closest('header')) return 'NAV';
  if (element.closest('footer')) return 'FOOTER';
  return 'CONTENT';
}

export function getLinkTextOrAlt(element) {
  if (element.tagName === 'IMG') {
    return element.alt || element.title || '';
  }
  if (element.tagName === 'A') {
    // Check if anchor contains an image
    const img = element.querySelector('img');
    if (img) return img.alt || img.title || element.textContent.trim();
    return element.textContent.trim() || element.title || '';
  }
  return element.textContent?.trim() || '';
}

export function isElementVisible(element) {
  if (!element) return false;
  const style = window.getComputedStyle(element);
  return style.display !== 'none' 
    && style.visibility !== 'hidden' 
    && style.opacity !== '0'
    && element.offsetWidth > 0 
    && element.offsetHeight > 0;
}

export async function checkLinksForBrokenStatus(links, envName = null) {
  const { spidy } = await getServiceConfig(window.location.origin, envName);
  const spidyUrl = spidy?.url || SPIDY_URL_FALLBACK;
  const canSpidy = await spidyCheck(spidyUrl);
  
  if (!canSpidy) {
    console.warn('Cannot connect to link checking service');
    return [];
  }

  const groups = makeGroups(links);
  const baseOpts = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
  const badResults = [];

  for (const group of groups) {
    const urls = group.map((link) => {
      let checkUrl = link.href;
      if (checkUrl.includes('hlx.page')) checkUrl = checkUrl.replace('hlx.page', 'hlx.live');
      if (checkUrl.includes('aem.page')) checkUrl = checkUrl.replace('aem.page', 'aem.live');
      return checkUrl;
    });
    
    const opts = { ...baseOpts, body: JSON.stringify({ urls }) };
    const spidyResults = await getSpidyResults(spidyUrl, opts);
    badResults.push(...spidyResults);
  }

  return badResults;
}

export function collectAllPageLinks() {
  const allLinks = [];
  const selectors = [
    'a[href]',
    'img[src$=".svg"]',
    'iframe'
  ];
  
  selectors.forEach(selector => {
    const elements = [...document.querySelectorAll(selector)];
    elements.forEach(el => {
      if (el.closest('.preflight')) return; // Skip preflight UI
      
      let url;
      try {
        if (el.tagName === 'A') {
          url = el.href;
        } else if (el.tagName === 'IMG') {
          url = el.src;
        } else if (el.tagName === 'IFRAME') {
          url = el.src;
        }
        
        if (url && !url.includes('tel:') && !url.includes('mailto:') && !url.startsWith('#')) {
          allLinks.push({
            element: el,
            href: url,
            tagName: el.tagName
          });
        }
      } catch (e) {
        // Skip invalid URLs
      }
    });
  });
  
  return allLinks;
}

export async function collectBrokenLinksData() {
  brokenLinksData.value = { ...brokenLinksData.value, loading: true };
  
  const brokenLinksArray = await getBrokenLinksDetails();
  
  brokenLinksData.value = { links: brokenLinksArray, loading: false };
  
  // Expose to window for external access (Milo Studio)
  if (!window.contentInsights) {
    window.contentInsights = {};
  }
  window.contentInsights.general = {
    brokenLinks: brokenLinksArray,
    fragments: content.value.fragments?.items || [],
    links: content.value.links?.items || [],
    svgs: content.value.svgs?.items || [],
    pdfs: content.value.pdfs?.items || [],
    nav: content.value.nav?.items || [],
    page: content.value.page?.items || []
  };
}
// Export function for external use (Milo Studio)
export async function getBrokenLinksDetails() {
  const currentUrl = new URL(window.location.href);
  const sourceUrl = `${currentUrl.origin}${currentUrl.pathname}`;
  const locale = getLocaleFromUrl(currentUrl);
  
  // Collect all links on the page
  const allPageLinks = collectAllPageLinks();
  
  // Check which links are broken
  const brokenResults = await checkLinksForBrokenStatus(allPageLinks);
  
  // Build detailed broken links data
  const brokenLinksArray = [];
  
  brokenResults.forEach(result => {
    const matchingLink = allPageLinks.find(link => {
      let checkUrl = link.href;
      if (checkUrl.includes('hlx.page')) checkUrl = checkUrl.replace('hlx.page', 'hlx.live');
      if (checkUrl.includes('aem.page')) checkUrl = checkUrl.replace('aem.page', 'aem.live');
      return checkUrl === result.url;
    });
    
    if (matchingLink) {
      const linkData = {
        sourceUrl,
        locale,
        brokenLinks: result.url,
        tagType: getTagType(matchingLink.element),
        position: getPosition(matchingLink.element),
        linkText: getLinkTextOrAlt(matchingLink.element),
        visibility: isElementVisible(matchingLink.element) ? 'TRUE' : 'FALSE',
        responseCode: result.status,
        redirectedUrl: result.redirectUrl || '',
        redirectedStatus: result.redirectStatus || 'NA'
      };
      
      brokenLinksArray.push(linkData);
    }
  });
  
  return brokenLinksArray;
}

const content = signal({});

const navResult = signal({ icon: 'purple', title: STRUCTURE_TITLES.navigation, description: 'Checking...' });
const footerResult = signal({ icon: 'purple', title: STRUCTURE_TITLES.footer, description: 'Checking...' });
const regionSelectorResult = signal({ icon: 'purple', title: STRUCTURE_TITLES.regionSelector, description: 'Checking...' });
const georoutingResult = signal({ icon: 'purple', title: STRUCTURE_TITLES.georouting, description: 'Checking...' });
const breadcrumbsResult = signal({ icon: 'purple', title: STRUCTURE_TITLES.breadcrumbs, description: 'Checking...' });

async function getStructureResults() {
  const signals = [
    navResult,
    footerResult,
    regionSelectorResult,
    georoutingResult,
    breadcrumbsResult,
  ];
  const checks = runStructureChecks({ area: document });

  const statusToIconMap = {
    [STATUS.PASS]: 'green',
    [STATUS.FAIL]: 'red',
    [STATUS.EMPTY]: 'empty',
  };

  await Promise.all(checks.map((result, index) => Promise.resolve(result)
    .then((res) => {
      const icon = statusToIconMap[res.status] || 'orange';
      signals[index].value = {
        icon,
        title: res.title,
        description: res.description,
      };
    })
    .catch((error) => {
      signals[index].value = {
        icon: 'red',
        title: 'Error',
        description: `Error: ${error.message}`,
      };
    })));
}

function getAdminUrl(url, type) {
  if (!(/adobecom\.(hlx|aem)./.test(url.hostname))) return false;
  const project = url.hostname === 'localhost' ? 'main--milo--adobecom' : url.hostname.split('.')[0];
  const [branch, repo, owner] = project.split('--');
  const base = `https://admin.hlx.page/${type}/${owner}/${repo}/${branch}${url.pathname}`;
  return type === 'status' ? `${base}?editUrl=auto` : base;
}

async function getStatus(url) {
  const adminUrl = getAdminUrl(url, 'status');
  if (!adminUrl) {
    return {
      url,
      edit: null,
      preview: nonEDSContent,
      live: nonEDSContent,
      publish: nonEDSContent,
      externalUrl: url,
    };
  }
  const resp = await fetch(adminUrl);
  if (!resp.ok) return {};
  const json = await resp.json();
  const preview = json.preview.lastModified || DEF_NEVER;
  const live = json.live.lastModified || DEF_NEVER;
  const publish = await userCanPublishPage(json, false);
  const { sourceLocation } = json.preview;
  const edit = json.edit?.url
    || (sourceLocation?.includes(DA_DOMAIN) && sourceLocation?.replace('markup:https://content.da.live', 'https://da.live/edit#'))
    || '';
  return { url, edit, preview, live, publish };
}

async function getStatuses() {
  Object.keys(content.value).forEach(async (key) => {
    content.value[key].items.forEach(async (item, idx) => {
      const status = await getStatus(item.url);
      content.value[key].items[idx] = status;
      content.value = { ...content.value };
    });
  });
}

function getUrl(el) {
  const { modalPath, modalHash, path: fragmentPath } = el.dataset;
  const dataPath = modalPath ? `${modalPath}${modalHash}` : fragmentPath;
  try {
    return new URL(dataPath);
  } catch {
    const isPdfIframe = el.src && el.nodeName === 'IFRAME' && el.parentElement?.dataset.pdfSrc;
    const elPath = el.href || (isPdfIframe ? el.parentElement.dataset.pdfSrc : el.src);
    const path = dataPath ? `${window.location.origin}${dataPath}` : elPath;
    return new URL(path);
  }
}

function findLinks(selector) {
  const hrefs = new Set();
  return [...document.body.querySelectorAll(selector)]
    .reduce((links, el) => {
      const url = getUrl(el);
      const baseUrl = `${url.origin}${url.pathname}`;
      if (EXCLUDED_PATHS.some((path) => url.pathname.includes(path))) return links;
      if (!hrefs.has(baseUrl)) {
        hrefs.add(baseUrl);
        links.push({ url, edit: null, preview: 'Fetching', live: 'Fetching' });
      }
      return links;
    }, []);
}

export function runGeneralChecks() {
  const contentValue = {
    page: { items: [{ url: new URL(window.location.href), edit: null, preview: 'Fetching', live: 'Fetching' }] },
    fragments: { items: findLinks('main .fragment, a[data-modal-path], [data-path]') },
    links: { items: findLinks('main a[href^="/"') },
    svgs: { items: findLinks('img[src$=".svg"') },
    pdfs: { items: findLinks('main iframe') },
    nav: { items: findLinks('header a[href^="/"'), closed: true },
    brokenLinks: { items: [], loading: false } // Add this
  };

  return contentValue;
}

async function setContent() {
  if (content.value.page) return;

  content.value = runGeneralChecks();

  getStatuses();
   // Check for broken links after content is loaded
   collectBrokenLinksData();
  const sk = document.querySelector('aem-sidekick, helix-sidekick');
  sk?.addEventListener('statusfetched', async () => { // sidekick v6
    getStatuses();
  });
  sk?.addEventListener('status-fetched', async () => { // sidekick v7
    getStatuses();
  });
}

async function handleAction(action) {
  Object.keys(content.value).map(async (key) => {
    content.value[key].items.forEach(async (item, idx) => {
      const checkPublish = action === 'live' ? (item.publish && !item.publish.canPublish) : false;
      if (!item.checked || checkPublish) return;
      content.value[key].items[idx].action = action;
      content.value = { ...content.value };
      const adminUrl = getAdminUrl(item.url, action);
      const resp = await fetch(adminUrl, { method: 'POST' });
      const json = resp.ok ? await resp.json() : NOT_FOUND;
      content.value[key].items[idx] = {
        ...item,
        action: null,
        preview: json.preview?.lastModified || item.preview,
        live: json.live?.lastModified || item.live,
      };
      content.value = { ...content.value };
    });
  });
}

function toggleSelect(checked) {
  const copy = { ...content.value };
  Object.keys(copy).forEach((key) => {
    if (copy[key].closed) return;
    copy[key].items.forEach((item) => { item.checked = !checked; });
  });
  content.value = copy;
}

function handleChange(target, name, idx) {
  if (target.nodeName === 'A') return;
  content.value[name].items[idx].checked = !content.value[name].items[idx].checked;
  content.value = { ...content.value };
}

function toggleGroup(name) {
  content.value[name].closed = !content.value[name].closed;
  content.value = { ...content.value };
}

function checkPublishing(item, isFetching) {
  if ((item.preview === DEF_NEVER && item.live === DEF_NEVER)
    || (item.preview === DEF_NOT_FOUND && item.live === DEF_NOT_FOUND)) {
    return ' not-found';
  }
  return isFetching;
}

function prettyDate(string) {
  if (Number.isNaN(Date.parse(string))) return string;

  const date = new Date(string);
  const localeDate = date.toLocaleString();
  const splitDate = localeDate.split(', ');

  return html`
    <span class=preflight-date>${splitDate[0]}</span>
    <span class=preflight-time>${splitDate[1]}</span>
  `;
}

function prettyPath(url) {
  if (!url) return '';
  if (url.pathname === window.location.pathname) return url.pathname;
  return url.hash ? `${url.pathname} (${url.hash})` : url.pathname;
}

function usePublishProps(item) {
  let disablePublish;
  if (item.publish && !item.publish.canPublish) {
    disablePublish = html`${item.publish.message}`;
  }
  return {
    publishText: html`${item.action === 'live' ? 'Publishing' : prettyDate(item.live)}`,
    disablePublish,
  };
}

function Item({ name, item, idx }) {
  const { publishText, disablePublish } = usePublishProps(item);
  const isChecked = item.checked ? ' is-checked' : '';
  const isFetching = item.edit || item.preview === nonEDSContent ? '' : ' is-fetching';
  const editIcon = item.edit && item.edit.includes(DA_DOMAIN) ? 'da-icon' : 'sharepoint-icon';
  const prettyUrl = item.externalUrl ? item.externalUrl.href : prettyPath(item.url);
  if (!item.url) return undefined;

  return html`
    <div class="preflight-group-row preflight-group-detail${isChecked}${checkPublishing(item, isFetching)}"
      onClick=${(e) => handleChange(e.target, name, idx)}>
      <p><a href=${item.externalUrl || item.url.pathname} target=_blank>${prettyUrl}</a></p>
      <p>${item.edit && html`<a href=${item.edit} class="preflight-edit ${editIcon}" target=_blank>EDIT</a>`}</p>
      <p class=preflight-date-wrapper>${item.action === 'preview' ? 'Previewing' : prettyDate(item.preview)}</p>
      <p class="preflight-date-wrapper">
        ${isChecked && disablePublish ? html`<span class=disabled-publish>${disablePublish}</span>` : publishText}
      </p>
    </div>`;
}

function ContentGroup({ name, group }) {
  if (group.items.length === 0) return null;
  const isClosed = group.closed ? ' is-closed' : '';

  return html`
    <div class="preflight-content-group${isClosed}">
      <div class="preflight-group-row preflight-group-heading" onClick=${() => toggleGroup(name)}>
        <div class="preflight-group-expand"></div>
        <p class=preflight-content-heading>${name}</p>
        ${name === 'page' && html`
          <p class="preflight-content-heading preflight-content-heading-edit">Edit</p>
          <p class=preflight-content-heading>Previewed</p>
          <p class=preflight-content-heading>Published</p>
        `}
      </div>
      <div class=preflight-group-items>
      ${group.items.map((item, idx) => html`<${Item} name=${name} idx=${idx} item=${item} />`)}
      </div>
    </div>`;
}

export default function General() {
  useEffect(() => { setContent(); getStructureResults(); }, []);

  const StructureItem = ({ icon, title, description }) => html`
    <div class="preflight-item">
      <div class="result-icon ${icon}"></div>
      <div class="preflight-item-text">
        <p class="preflight-item-title">${title}</p>
        <p class="preflight-item-description">${description}</p>
      </div>
    </div>`;

  const allChecked = Object.values(content.value)
    .flatMap((item) => item.items).filter((item) => item.checked);

  const checked = !!allChecked.length;
  const publishable = allChecked
    .filter((item) => item.checked && !!item.publish?.canPublish).length;

  const hasPage = content.value.page;
  const selectStyle = checked ? 'Select none' : 'Select all';

  const tooltip = allChecked.length !== publishable && 'Puplishing disabled pages will be ignored';

  return html`
    <div class=preflight-general-content>
    <p class="preflight-structure-title">Structure</p>
       <div class=preflight-structure-columns>
        <div class=preflight-column>
          <${StructureItem} ...${navResult.value} />
          <${StructureItem} ...${footerResult.value} />
          <${StructureItem} ...${regionSelectorResult.value} />
        </div>
        <div class=preflight-column>
          <${StructureItem} ...${georoutingResult.value} />
          <${StructureItem} ...${breadcrumbsResult.value} />
        </div>
      </div>
      ${Object.keys(content.value).map((key) => html`<${ContentGroup} name=${key} group=${content.value[key]} />`)}
    </div>

    <div class=preflight-actions>
      ${hasPage && html`
        <div id=select-action class=preflight-action-wrapper>
          <button class=preflight-action onClick=${() => toggleSelect(checked)}>${selectStyle}</button>
        </div>
      `}
      ${checked && html`
        <div id=preview-action class=preflight-action-wrapper>
          <button class=preflight-action onClick=${() => handleAction('preview')}>Preview</button>
        </div>
        ${!!publishable && html`
          <div id=publish-action class="preflight-action-wrapper${tooltip ? ' tooltip' : ''}" data-tooltip=${tooltip}>
            <button class="preflight-action" onClick=${() => handleAction('live')}>
              Publish
            </button>
          </div>
        `}
      `}
    </div>
  `;
}
