import { URL, URLSearchParams } from 'url';
import { Route, isHandler, HandleValue } from '@vercel/routing-utils';
import PCRE from 'pcre-to-regexp';

import isURL from './util/is-url';
import { RouteResult, HTTPHeaders } from './types';

// Since we have no replacement for url.parse, thanks Node.js
// https://github.com/nodejs/node/issues/12682
const baseUrl = 'http://example.org';

function parseUrl(url: string) {
  const _url = new URL(url, baseUrl);
  return {
    pathname: _url.pathname,
    searchParams: _url.searchParams,
  };
}

/**
 * Appends URLSearchParams from param 2 to param 1.
 * Basically Object.assign for URLSearchParams
 * @param param1
 * @param param2
 */
function appendURLSearchParams(
  param1: URLSearchParams,
  param2: URLSearchParams
) {
  for (const [key, value] of param2.entries()) {
    param1.append(key, value);
  }
  return param1;
}

/**
 *
 * @param str
 * @param match
 * @param keys
 */
function resolveRouteParameters(
  str: string,
  match: string[],
  keys: string[]
): string {
  return str.replace(/\$([1-9a-zA-Z]+)/g, (_, param) => {
    let matchIndex: number = keys.indexOf(param);
    if (matchIndex === -1) {
      // It's a number match, not a named capture
      matchIndex = parseInt(param, 10);
    } else {
      // For named captures, add one to the `keys` index to
      // match up with the RegExp group matches
      matchIndex++;
    }
    return match[matchIndex] || '';
  });
}

export class Proxy {
  routes: Route[];
  lambdaRoutes: Set<string>;
  staticRoutes: Set<string>;

  constructor(routes: Route[], lambdaRoutes: string[], staticRoutes: string[]) {
    this.routes = routes;
    this.lambdaRoutes = new Set<string>(lambdaRoutes);
    this.staticRoutes = new Set<string>(staticRoutes);
  }

  _checkFileSystem = (path: string) => {
    return this.staticRoutes.has(path);
  };

  route(reqUrl: string) {
    const parsedUrl = parseUrl(reqUrl);
    let { searchParams, pathname: reqPathname = '/' } = parsedUrl;
    let result: RouteResult | undefined;
    let status: number | undefined;
    let isContinue = false;
    let idx = -1;
    let phase: HandleValue | undefined;
    let combinedHeaders: HTTPHeaders = {};

    for (const routeConfig of this.routes) {
      /**
       * This is how the routing basically works
       * 1. Checks if the route is an exact match to a route in the
       *    S3 filesystem (e.g. /test.html -> s3://test.html)
       *    --> true: returns found in filesystem
       * 2.
       *
       */

      idx++;
      isContinue = false;

      //////////////////////////////////////////////////////////////////////////
      // Phase 1: Check for handler
      if (isHandler(routeConfig)) {
        phase = routeConfig.handle;

        // Check if the path is a static file that should be served from the
        // filesystem
        if (routeConfig.handle === 'filesystem') {
          // Check if the route matches a route from the filesystem
          if (this._checkFileSystem(reqPathname)) {
            result = {
              found: true,
              target: 'filesystem',
              dest: reqPathname,
              headers: combinedHeaders,
              continue: false,
              isDestUrl: false,
            };
            break;
          }
        }

        continue;
      }

      //////////////////////////////////////////////////////////////////////////
      // Phase 2: Check for source
      const { src, headers } = routeConfig;
      let keys: string[] = []; // Filled by PCRE in next step
      // Note: Routes are case-insensitive
      // PCRE tries to match the path to the regex of the route
      // It also parses the parameters to the keys variable
      const matcher = PCRE(`%${src}%i`, keys);
      const match =
        matcher.exec(reqPathname) || matcher.exec(reqPathname!.substring(1));

      if (match !== null) {
        // The path that should be sent to the target system (lambda or filesystem)
        let destPath: string = reqPathname;

        if (routeConfig.dest) {
          // Rewrite dynamic routes
          // e.g. /posts/1234 -> /posts/[id]?id=1234
          destPath = resolveRouteParameters(routeConfig.dest, match, keys);
        }

        if (headers) {
          for (const originalKey of Object.keys(headers)) {
            const lowerKey = originalKey.toLowerCase();
            const originalValue = headers[originalKey];
            const value = resolveRouteParameters(originalValue, match, keys);
            combinedHeaders[lowerKey] = value;
          }
        }

        if (routeConfig.continue) {
          if (routeConfig.status) {
            status = routeConfig.status;
          }
          reqPathname = destPath;
          isContinue = true;
          continue;
        }

        if (routeConfig.check && phase !== 'hit') {
          if (!this.lambdaRoutes.has(destPath)) {
            // When it is not a lambda route we cut the url_args
            // for the next iteration
            const nextUrl = parseUrl(destPath);
            reqPathname = nextUrl.pathname!;

            // Check if we have a static route
            if (!this.staticRoutes.has(reqPathname)) {
              appendURLSearchParams(searchParams, nextUrl.searchParams);
              continue;
            }
          }
        }

        const isDestUrl = isURL(destPath);

        if (isDestUrl) {
          result = {
            found: true,
            dest: destPath,
            continue: isContinue,
            userDest: false,
            isDestUrl,
            status: routeConfig.status || status,
            uri_args: searchParams,
            matched_route: routeConfig,
            matched_route_idx: idx,
            phase,
            headers: combinedHeaders,
          };
          break;
        } else {
          if (!destPath.startsWith('/')) {
            destPath = `/${destPath}`;
          }

          const destParsed = parseUrl(destPath);
          appendURLSearchParams(searchParams, destParsed.searchParams);
          result = {
            found: true,
            dest: destParsed.pathname || '/',
            continue: isContinue,
            userDest: Boolean(routeConfig.dest),
            isDestUrl,
            status: routeConfig.status || status,
            uri_args: searchParams,
            matched_route: routeConfig,
            matched_route_idx: idx,
            phase,
            headers: combinedHeaders,
          };
          break;
        }
      }
    }

    if (!result) {
      result = {
        found: false,
        dest: reqPathname,
        continue: isContinue,
        status,
        isDestUrl: false,
        uri_args: searchParams,
        phase,
        headers: combinedHeaders,
      };
    }

    return result;
  }
}
