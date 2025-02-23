/*
 * https://github.com/digitalfortress-tech/typeahead-standalone
 * Copyright (c) 2020 Niket Pathak
 * MIT License
 */

import type {
  typeaheadResult,
  typeaheadConfig,
  typeaheadHtmlTemplates,
  Dictionary,
  LocalDataSource,
  RemoteDataSource,
  PrefetchDataSource,
  ResultSet,
} from './types';
import { Keys } from './constants';
import { diacritics, escapeRegExp, isObject, NOOP, normalizer } from './helpers';
import { fetchWrapper } from './fetchWrapper/fetchWrapper';
import { Trie } from './trie/trie';
import './style.less';

export default function typeahead<T extends Dictionary>(config: typeaheadConfig<T>): typeaheadResult<T> {
  // check required params
  if (!config.input) throw new Error('e01');
  if (!config.source || !isObject(config.source)) throw new Error('e02');

  const doc = document;

  const listContainer: HTMLDivElement = doc.createElement('div');
  const listContainerStyle = listContainer.style;
  const debounceXHR = config.debounceRemote || 100;
  const preventSubmit = config.preventSubmit || false;
  const minLen = config.minLength || 1;
  const hint = config.hint === false ? false : true;
  const autoSelect = config.autoSelect || false;
  const templates: typeaheadHtmlTemplates<T> | undefined = config.templates;
  const trie = Trie({ hasDiacritics: config.diacritics });
  const identifier = config.source.identifier || 'label'; // label is the default identifier
  const groupIdentifier = config.source.groupIdentifier || '';
  const displayCb = <T extends Dictionary>(item: T): string => {
    return `${item[identifier]}`;
  };
  const display: (item: T, e?: MouseEvent | KeyboardEvent | null) => string = config.display || displayCb;
  const identity = config.source.identity || displayCb;
  const onSubmit: (e: Event, item?: T) => void = config.onSubmit || NOOP;
  const dataTokens = config.source.dataTokens?.constructor === Array ? config.source.dataTokens : undefined;
  const remoteQueryCache: Dictionary = {};
  const remoteResponseCache: Dictionary = {};
  const transform = config.source.transform || ((data) => data);
  const local = (config.source as LocalDataSource<T>).local || null;
  const remote =
    (config.source as RemoteDataSource<T>).remote &&
    (config.source as RemoteDataSource<T>).remote.url &&
    (config.source as RemoteDataSource<T>).remote.wildcard
      ? (config.source as RemoteDataSource<T>).remote
      : null;
  const prefetch =
    (config.source as PrefetchDataSource<T>).prefetch && (config.source as PrefetchDataSource<T>).prefetch.url
      ? { ...{ when: 'onInit', done: false }, ...(config.source as PrefetchDataSource<T>).prefetch }
      : null;

  // validate presence of atleast one data-source
  if (!local && !prefetch && !remote) throw new Error('e02');

  const resultSet: ResultSet<T> = {
    query: '',
    items: [], // suggestions
    count: 0,
    limit: config.limit || 5,
  };

  let selected: T | undefined;
  let remoteDebounceTimer: number | undefined;
  let fetchInProgress = false;
  let storedInput = ''; // used only for keyboard navigation

  // init templates if they exist
  if (templates) {
    templates.header = typeof templates.header === 'function' ? templates.header : undefined;
    templates.footer = typeof templates.footer === 'function' ? templates.footer : undefined;
    templates.notFound = typeof templates.notFound === 'function' ? templates.notFound : undefined;
    templates.group = typeof templates.group === 'function' ? templates.group : undefined;
    templates.suggestion = typeof templates.suggestion === 'function' ? templates.suggestion : undefined;
    templates.loader = typeof templates.loader === 'function' ? templates.loader : undefined;
    templates.empty = typeof templates.empty === 'function' ? templates.empty : undefined;
  }

  if (local) {
    updateSearchIndex(normalizer(local, identifier) as T[]);
  }

  const input: HTMLInputElement = config.input;
  input.classList.add('tt-input');

  // Wrapper element
  const wrapper: HTMLSpanElement = doc.createElement('span');
  wrapper.className = `typeahead-standalone${config.className ? ` ${config.className}` : ''}`;
  resultSet.container = wrapper;

  // move input element into the wrapper element
  const parentEl = input.parentNode as HTMLElement;
  const inputIndex = [...parentEl.children].indexOf(input);
  parentEl.removeChild(input);
  wrapper.appendChild(input);

  // append Wrapper element to the original parent
  parentEl.insertBefore(wrapper, parentEl.children[inputIndex]);

  // generate markup for hints
  const inputHint: HTMLInputElement = input.cloneNode() as HTMLInputElement;
  hint && injectHintEl(inputHint);

  listContainer.classList.add('tt-list', 'tt-hide');
  listContainer.tabIndex = 0;
  listContainer.setAttribute('aria-label', 'menu-options');
  listContainer.setAttribute('role', 'listbox');

  // set listContainer positioning
  listContainerStyle.position = 'absolute'; // IOS implementation for fixed positioning has many bugs, so we will use absolute positioning
  listContainerStyle.width = '100%'; // fix position of listContainer
  listContainerStyle.left = '0';
  // listContainerStyle.top = `${input.clientHeight}px`; // or top: '100%' // not required apparently

  // Attach list container
  wrapper.appendChild(listContainer);

  if (prefetch && prefetch.when === 'onInit') {
    prefetchData();
  }

  function prefetchData() {
    // check if data was already prefetched for current session
    if (!prefetch || prefetch.done) return;

    let transformed: T[] = [];

    fetchWrapper
      .get(typeof prefetch.url === 'function' ? prefetch.url() : prefetch.url, prefetch?.requestOptions)
      .then(
        (data) => {
          transformed = transform(data) as T[];
          transformed = normalizer(transformed, identifier) as T[];
          updateSearchIndex(transformed);
        },
        (reject) => {
          console.error('e04', reject);
        }
      )
      .finally(() => {
        typeof prefetch.process === 'function' && prefetch.process(transformed);
      });

    prefetch.done = true;
  }

  /**
   * Display/show the listContainer
   */
  const show = (): void => {
    listContainer.classList.remove('tt-hide');
  };

  /**
   * Hides the listContainer from DOM
   */
  const hide = (): void => {
    listContainer.classList.add('tt-hide');
  };

  /**
   * Flag to indicate if the list of suggestions is open or not
   * @returns Boolean
   */
  const isListOpen = (): boolean => !listContainer.classList.contains('tt-hide');

  /**
   * Clear remote debounce timer if assigned
   */
  const clearRemoteDebounceTimer = (): void => {
    if (remoteDebounceTimer) {
      window.clearTimeout(remoteDebounceTimer);
    }
  };

  /**
   * Clear typeahead state and hide listContainer
   */
  const clear = (): void => {
    resultSet.items = [];
    inputHint.value = '';
    storedInput = '';
    hide();
  };

  /**
   * Displays the NotFound template if it exists, otherwise, does nothing (i.e. returns true)
   * @param asyncRender set to true for asyncRenders
   * @returns true if no suggestions are found, else returns undefined
   */
  const noSuggestionsHandler = (asyncRender = false) => {
    if (!resultSet.items.length && resultSet.query) {
      // clear the list and the DOM
      clear();
      clearListDOM();

      const notFoundTemplateHtml = templates?.notFound && templates.notFound(resultSet);
      if (!notFoundTemplateHtml) return true;

      const renderNotFoundTemplate = (html: string) => {
        const notFoundEl = doc.createElement('div');
        notFoundEl.classList.add('tt-notFound');
        templatify(notFoundEl, html);
        listContainer.appendChild(notFoundEl);
      };

      if (!remote) {
        renderNotFoundTemplate(notFoundTemplateHtml);
      } else if (remoteQueryCache[JSON.stringify(resultSet.query)] || (asyncRender && !fetchInProgress)) {
        // wait for remote results before rendering notFoundTemplate / render immediately if request was cached
        renderNotFoundTemplate(notFoundTemplateHtml);
      }

      show();
      return true;
    }
  };

  /**
   * Delete all children from typeahead DOM listContainer
   */
  const clearListDOM = () => {
    while (listContainer.firstChild) {
      listContainer.firstChild.remove();
    }
  };

  const loader = () => {
    if (!templates?.loader) {
      return;
    }

    if (!fetchInProgress) {
      const loaderEl = listContainer.querySelector('.tt-loader');
      loaderEl && listContainer.removeChild(loaderEl);
      return;
    }

    // display spinner/loader
    const loaderDiv = doc.createElement('div');
    loaderDiv.classList.add('tt-loader');
    templatify(loaderDiv, templates.loader());
    if (templates?.footer) {
      listContainer.insertBefore(loaderDiv, listContainer.querySelector('.tt-footer'));
    } else {
      listContainer.appendChild(loaderDiv);
    }
  };

  /**
   * Responsible for drawing/updating the view
   */
  const update = (): void => {
    // No Matches
    if (noSuggestionsHandler()) return;

    clearListDOM();

    // function for rendering typeahead suggestions
    const render = (item: T): HTMLDivElement => {
      const itemElement = doc.createElement('div');
      itemElement.classList.add('tt-suggestion');
      itemElement.setAttribute('role', 'option');
      itemElement.setAttribute('aria-selected', 'false');
      itemElement.setAttribute('aria-label', display(item));
      if (templates?.suggestion) {
        templatify(itemElement, templates.suggestion(item, resultSet));
      } else {
        itemElement.textContent = (item[identifier] as string) || '';
      }
      return itemElement;
    };

    // function to render typeahead groups
    const renderGroup = (groupName: string): HTMLDivElement => {
      const groupDiv = doc.createElement('div');
      groupDiv.classList.add('tt-group');
      groupDiv.setAttribute('role', 'group');
      groupDiv.setAttribute('aria-label', groupName);
      if (templates?.group) {
        templatify(groupDiv, templates.group(groupName, resultSet));
      } else {
        groupDiv.textContent = groupName || '';
      }
      return groupDiv;
    };

    const fragment = doc.createDocumentFragment();
    const prevGroups: string[] = [];

    // Add header template
    if (templates?.header) {
      const headerDiv = doc.createElement('div');
      headerDiv.classList.add('tt-header');
      headerDiv.setAttribute('role', 'heading');
      headerDiv.setAttribute('aria-level', '1');
      const templateHtml = templatify(headerDiv, templates.header(resultSet));
      templateHtml && fragment.appendChild(headerDiv);
    }

    // loop over suggestions
    for (const [index, item] of resultSet.items.entries()) {
      if (index === resultSet.limit) break;

      // attach group if available
      if (item[groupIdentifier] && !prevGroups.includes(item[groupIdentifier] as string)) {
        prevGroups.push(item[groupIdentifier] as string);
        const groupDiv = renderGroup(item[groupIdentifier] as string);
        fragment.appendChild(groupDiv);
      }

      // attach suggestion
      const div = render(item);
      div.addEventListener('click', function (ev: MouseEvent): void {
        clear();
        selected = item;
        input.value = display(item, ev);
        ev.preventDefault();
      });
      if (item === selected) {
        div.classList.add('tt-selected');
        div.setAttribute('aria-selected', 'true');
      }
      fragment.appendChild(div);

      // highlight matched text
      config.highlight && hightlight(div, resultSet.query);
    }

    // Add footer template
    if (templates?.footer) {
      const footerDiv = doc.createElement('div');
      footerDiv.classList.add('tt-footer');
      footerDiv.setAttribute('role', 'heading');
      footerDiv.setAttribute('aria-level', '2');
      const templateHtml = templatify(footerDiv, templates.footer(resultSet));
      templateHtml && fragment.appendChild(footerDiv);
    }

    listContainer.appendChild(fragment);

    // update hint if its enabled
    hint && updateHint(selected || resultSet.items[0]);

    // scroll when not in view
    listContainer.querySelector('.tt-selected')?.scrollIntoView({ block: 'nearest' });

    show();
  };

  const inputEventHandler = (ev: KeyboardEvent): void => {
    const keyCode = ev.which || ev.keyCode || 0;

    if (keyCode === Keys.Down) {
      return;
    }

    storedInput = input.value;
    startFetch();
  };

  /**
   * Select the previous item in suggestions
   */
  const selectPrev = (ev: KeyboardEvent): void => {
    const maxLength = resultSet.items.length >= resultSet.limit ? resultSet.limit : resultSet.items.length;
    // if first item is selected and UP Key is pressed, focus input and restore original input
    if (selected === resultSet.items[0]) {
      selected = undefined;
      input.value = storedInput;
      return;
    }
    // if focus is on input, and UP Key is pressed, select last item
    if (!selected) {
      selected = resultSet.items[maxLength - 1];
    } else {
      for (let i = maxLength - 1; i > 0; i--) {
        if (selected === resultSet.items[i] || i === 1) {
          selected = resultSet.items[i - 1];
          break;
        }
      }
    }

    input.value = display(selected, ev);
  };

  /**
   * Select the next item in suggestions
   */
  const selectNext = (ev: KeyboardEvent): void => {
    const maxLength = resultSet.items.length >= resultSet.limit ? resultSet.limit : resultSet.items.length;
    // if nothing selected, select the first suggestion
    if (!selected) {
      selected = resultSet.items[0];
      input.value = display(selected, ev);
      return;
    }
    // if we're at the end of the list, go to input box and restore original input
    if (selected === resultSet.items[maxLength - 1]) {
      selected = undefined;
      input.value = storedInput;
      return;
    }

    for (let i = 0; i < maxLength - 1; i++) {
      if (selected === resultSet.items[i]) {
        selected = resultSet.items[i + 1];
        break;
      }
    }

    input.value = display(selected, ev);
  };

  const keydownEventHandler = (ev: KeyboardEvent): void => {
    // if raw input is empty, clear out everything
    if (!input.value.length) {
      clear();
      return;
    }

    const keyCode = ev.which || ev.keyCode || 0;

    if (keyCode === Keys.Up || keyCode === Keys.Down || keyCode === Keys.Esc) {
      if (keyCode === Keys.Esc) {
        clear();
      } else if (resultSet.items.length) {
        keyCode === Keys.Up ? selectPrev(ev) : selectNext(ev);
        update();
      }

      ev.preventDefault();
      ev.stopPropagation();

      return;
    }

    const useSelectedValue = function (fallback = false) {
      if (!selected && fallback && resultSet.items.length) {
        selected = resultSet.items[0];
      }
      if (selected) {
        clear();
        input.value = display(selected, ev);
        return selected;
      }
    };

    if (keyCode === Keys.Enter) {
      preventSubmit && ev.preventDefault();
      onSubmit(ev, useSelectedValue());

      return;
    }

    if (keyCode === Keys.Tab && isListOpen()) {
      ev.preventDefault();
      useSelectedValue(true);
    }
  };

  const focusEventHandler = (): void => {
    if (prefetch && prefetch.when === 'onFocus') {
      prefetchData();
    }
    startFetch();
  };

  const startFetch = (): void => {
    clearRemoteDebounceTimer();
    const val = input.value.replace(/\s{2,}/g, ' ').trim();

    // empty/default template
    if (templates?.empty && !val.length) {
      const emptyHtml = templates.empty(resultSet);
      resultSet.query = '';
      if (resultSet.defaultItems?.length) {
        // inject default suggestions
        resultSet.items = normalizer(transform(resultSet.defaultItems) as T[], identifier) as T[];
        return update();
      }

      // inject empty html template only if default suggestions aren't provided
      clear();
      clearListDOM();
      const emptyEl = doc.createElement('div');
      emptyEl.classList.add('tt-empty');
      templatify(emptyEl, emptyHtml);
      emptyHtml && listContainer.appendChild(emptyEl);
      return show();
    }

    if (val.length >= minLen) {
      resultSet.query = val;
      calcSuggestions();

      // if remote source exists, first check remote cache before making any query
      const thumbprint = JSON.stringify(resultSet.query);
      if (remote && resultSet.items.length < resultSet.limit && (remoteResponseCache[thumbprint] as [])?.length) {
        calcSuggestions(remoteResponseCache[thumbprint] as []);
      }

      update(); // update view

      remoteDebounceTimer = window.setTimeout(function (): void {
        if (resultSet.items.length < resultSet.limit && !fetchInProgress) {
          fetchDataFromRemote();
        }
      }, debounceXHR);
    } else {
      resultSet.query = '';
      clear();
    }
  };

  const formatQuery = (ip = '') => {
    if (config.diacritics) {
      ip = diacritics(ip);
    }

    return ip.toLowerCase();
  };

  const calcSuggestions = (newItems?: T[]): void => {
    // get suggestions
    let { suggestions, count }: { suggestions: T[]; count: number } = trie.search(resultSet.query, resultSet.limit);

    if (newItems?.length) {
      newItems.push(...suggestions); // merge suggestions

      const uniqueItems = {} as Dictionary<T>;
      newItems.forEach((item) => {
        uniqueItems[identity(item)] = item;
      });

      suggestions = Object.values(uniqueItems);
      count = suggestions.length;
    }

    // sort by starting letter of the query
    sortByStartingLetter(suggestions);

    // if suggestions need to be grouped, sort them by group
    if (groupIdentifier) {
      sortByGroup(suggestions);
    }

    // update items with available suggestions
    resultSet.items = suggestions;
    resultSet.count = count;

    selected = undefined; // unselect previously calculated/cached suggestion
    if (autoSelect && resultSet.items.length) {
      selected = resultSet.items[0];
    }
  };

  const fetchDataFromRemote = () => {
    if (!remote) return;

    fetchInProgress = true;
    const frozenInput = resultSet.query;
    const thumbprint = JSON.stringify(frozenInput);

    // check cache, verify input length
    if (remoteQueryCache[thumbprint] || !resultSet.query.length) {
      fetchInProgress = false;
      noSuggestionsHandler(true);
      return;
    }

    loader();

    let transformed: T[] = [];

    fetchWrapper
      .get(
        (typeof remote.url === 'function' ? remote.url() : remote.url).replace(remote.wildcard, frozenInput),
        remote?.requestOptions
      )
      .then(
        (data) => {
          transformed = transform(data) as T[];
          transformed = normalizer(transformed, identifier) as T[];
          updateSearchIndex(transformed);
        },
        (reject) => {
          console.error('e05', reject);
        }
      )
      .finally(() => {
        // cache XHR requests so that same calls aren't made multiple times
        remoteQueryCache[thumbprint] = true;
        remoteResponseCache[thumbprint] = transformed || [];
        fetchInProgress = false;
        loader();
        if (transformed.length && resultSet.query.length) {
          calcSuggestions(transformed);
          update();
        }

        // make another request if inputVal exists but is different than the last remote request
        if (resultSet.query.length && frozenInput !== resultSet.query) {
          fetchDataFromRemote();
        }
        noSuggestionsHandler(true);
      });
  };

  /**
   * Update the search Index with the identifier + dataTokens
   */
  function updateSearchIndex(iterable: T[]) {
    if (!iterable.length) return;

    // add new items to the search index
    trie.add(iterable, identifier, identity);
    if (dataTokens) {
      dataTokens.forEach((token) => {
        trie.add(iterable, token, identity);
      });
    }
  }

  /**
   * Sorts array in place giving preference to the starting letter of the query
   */
  const sortByStartingLetter = (suggestions: T[]): void => {
    suggestions.sort((a: Dictionary, b: Dictionary) => {
      const one = (a[identifier as string] as string).toLowerCase().startsWith(resultSet.query.toLowerCase());
      const two = (b[identifier as string] as string).toLowerCase().startsWith(resultSet.query.toLowerCase());

      if (one && !two) return -1;

      if (one && (a[identifier as string] as string).length < (b[identifier as string] as string).length) {
        return -1;
      }

      return 0;
    });
  };

  /**
   * Sorts(in-place) array by group
   */
  const sortByGroup = (suggestions: T[]) => {
    suggestions.sort((a: Dictionary, b: Dictionary) => {
      if (!a[groupIdentifier] || (a[groupIdentifier] as string) < (b[groupIdentifier] as string)) {
        return -1;
      }
      if ((a[groupIdentifier] as string) > (b[groupIdentifier] as string)) {
        return 1;
      }
      return 0;
    });
  };

  /**
   * Highlights a given text by its pattern
   * @param Elm The listContainer element
   * @param pattern the string to highlight
   */
  const hightlight = (Elm: HTMLElement, pattern: string): void => {
    const getRegex = (query: string, wordsOnly: boolean) => {
      const escapedQuery = escapeRegExp(query);
      const regexStr = wordsOnly ? '\\b(' + escapedQuery + ')\\b' : '(' + escapedQuery + ')';
      return new RegExp(regexStr, 'i');
    };

    const hightlightTextNode = (textNode: Text) => {
      let match = regex.exec(textNode.data);

      // check for diacritics if necessary
      if (config.diacritics && !match) {
        match = regex.exec(diacritics(textNode.data));
      }

      const wrapperNode = doc.createElement('span');
      wrapperNode.className = 'tt-highlight';

      if (match) {
        const patternNode = textNode.splitText(match.index);
        patternNode.splitText(match[0].length);
        wrapperNode.appendChild(patternNode.cloneNode(true));

        textNode?.parentNode?.replaceChild(wrapperNode, patternNode);
      }

      return !!match;
    };

    const traverse = (el: HTMLElement | ChildNode, hightlightTextNode: (textNode: Text) => boolean) => {
      const TEXT_NODE_TYPE = 3;
      let childNode;

      for (let i = 0; i < el.childNodes.length; i++) {
        childNode = el.childNodes[i];

        if (childNode.nodeType === TEXT_NODE_TYPE) {
          i += hightlightTextNode(childNode as Text) ? 1 : 0;
        } else {
          traverse(childNode, hightlightTextNode);
        }
      }
    };

    const regex = getRegex(pattern, false);
    pattern && traverse(Elm, hightlightTextNode);
  };

  /**
   * injects Hint input element into the DOM
   * @param inputHint the input hint element
   */
  function injectHintEl(inputHint: HTMLInputElement) {
    ['id', 'name', 'placeholder', 'required'].forEach((attr) => inputHint.removeAttribute(attr));
    inputHint.setAttribute('readonly', 'true');
    inputHint.setAttribute('aria-hidden', 'true');
    inputHint.tabIndex = -1;
    inputHint.className = 'tt-hint';

    input.after(inputHint);
  }

  /**
   * Updates the value of hint
   * @param selectedItem The selected item
   */
  const updateHint = (selectedItem: T) => {
    const rawInput = input.value;

    // if raw string is not part of suggestion, hide the hint
    if (
      !rawInput ||
      display(selectedItem) === rawInput || // if input string is exactly the same as selectedItem
      formatQuery(display(selectedItem)).indexOf(
        formatQuery(rawInput)
          .replace(/\s{2,}/g, ' ')
          .trimStart()
      ) !== 0
    ) {
      inputHint.value = '';
    } else {
      const item = display(selectedItem);
      const regex = new RegExp(escapeRegExp(resultSet.query), 'i');
      let match = regex.exec(item);

      // check for diacritics if necessary
      if (config.diacritics && !match) {
        match = regex.exec(diacritics(item));
      }

      if (match) {
        inputHint.value = (rawInput.replace(/\s?$/, '') + item.substring(match[0].length)) as string;
      }
    }
  };

  /**
   * Creates and appends a template to an HTMLElement
   * @param El The html element that the template should attach to
   * @param templateHtml The raw string representation of the html template
   */
  const templatify = (El: HTMLElement | DocumentFragment, templateHtml: string) => {
    const template = doc.createElement('template');
    template.innerHTML = templateHtml;
    El.appendChild(template.content);
    return templateHtml;
  };

  const blurEventHandler = (): void => {
    // we need to delay clear, because when we click on an item, blur will be called before click and remove items from DOM
    setTimeout(() => {
      if (doc.activeElement !== input) {
        clear();
      }
    }, 50);
  };

  /**
   * Handle Long clicks
   */
  listContainer.addEventListener('mousedown', function (e: Event) {
    e.stopPropagation();
    e.preventDefault();
  });

  /**
   * This function will remove DOM elements and clear event handlers
   */
  const destroy = (): void => {
    clearRemoteDebounceTimer();
    wrapper.replaceWith(input.cloneNode());
  };

  // setup event handlers
  input.addEventListener('keydown', keydownEventHandler);
  input.addEventListener('input', inputEventHandler as EventListenerOrEventListenerObject);
  input.addEventListener('blur', blurEventHandler);
  input.addEventListener('focus', focusEventHandler);

  return {
    destroy,
    // trie: Trie, // we expose trie only for local tests
  };
}
