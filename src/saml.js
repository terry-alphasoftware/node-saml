const debug = require('debug')('passport-saml');
const zlib = require('zlib');
const xml2js = require('xml2js');
const xmlCrypto = require('xml-crypto');
const crypto = require('crypto');
const xmldom = require('xmldom');
const url = require('url');
const querystring = require('querystring');
const xmlbuilder = require('xmlbuilder');
const xmlenc = require('xml-encryption');
const xpath = xmlCrypto.xpath;
const InMemoryCacheProvider = require('./inmemory-cache-provider.js').CacheProvider;
const algorithms = require('./algorithms');
const {signAuthnRequestPost} = require('./saml-post-signing');
const {promisify} = require('util');

class SAML {
  constructor(options) {
    this.options = this.initialize(options);
    this.cacheProvider = this.options.cacheProvider;
  }

  initialize(options) {
    if (!options) {
      options = {};
    }

    if (Object.prototype.hasOwnProperty.call(options, 'cert') && !options.cert) {
      throw new Error('Invalid property: cert must not be empty');
    }

    if (!options.path) {
      options.path = '/saml/consume';
    }

    if (!options.host) {
      options.host = 'localhost';
    }

    if (!options.issuer) {
      options.issuer = 'onelogin_saml';
    }

    if (options.identifierFormat === undefined) {
      options.identifierFormat = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";
    }

    if (options.authnContext === undefined) {
      options.authnContext = "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport";
    }

    if (!Array.isArray(options.authnContext)) {
      options.authnContext = [options.authnContext];
    }

    if (!options.acceptedClockSkewMs) {
      // default to no skew
      options.acceptedClockSkewMs = 0;
    }

    if(!options.validateInResponseTo){
      options.validateInResponseTo = false;
    }

    if(!options.requestIdExpirationPeriodMs){
      options.requestIdExpirationPeriodMs = 28800000;  // 8 hours
    }

    if(!options.cacheProvider){
        options.cacheProvider = new InMemoryCacheProvider(
            {keyExpirationPeriodMs: options.requestIdExpirationPeriodMs });
    }

    if (!options.logoutUrl) {
      // Default to Entry Point
      options.logoutUrl = options.entryPoint || '';
    }

    // sha1, sha256, or sha512
    if (!options.signatureAlgorithm) {
      options.signatureAlgorithm = 'sha1';
    }

    /**
     * List of possible values:
     * - exact : Assertion context must exactly match a context in the list
     * - minimum:  Assertion context must be at least as strong as a context in the list
     * - maximum:  Assertion context must be no stronger than a context in the list
     * - better:  Assertion context must be stronger than all contexts in the list
     */
    if (!options.RACComparison || !['exact','minimum','maximum','better'].includes(options.RACComparison)){
      options.RACComparison = 'exact';
    }

    return options;
  }

  getProtocol({protocol}) {
    return this.options.protocol || (protocol || 'http').concat('://');
  }

  getCallbackUrl(req) {
      // Post-auth destination
    if (this.options.callbackUrl) {
      return this.options.callbackUrl;
    } else {
      let host;
      if (req.headers) {
        host = req.headers.host;
      } else {
        host = this.options.host;
      }
      return this.getProtocol(req) + host + this.options.path;
    }
  }

  generateUniqueID() {
    return crypto.randomBytes(10).toString('hex');
  }

  generateInstant() {
    return new Date().toISOString();
  }

  signRequest(samlMessage) {
    let signer;
    const samlMessageToSign = {};
    samlMessage.SigAlg = algorithms.getSigningAlgorithm(this.options.signatureAlgorithm);
    signer = algorithms.getSigner(this.options.signatureAlgorithm);
    if (samlMessage.SAMLRequest) {
      samlMessageToSign.SAMLRequest = samlMessage.SAMLRequest;
    }
    if (samlMessage.SAMLResponse) {
      samlMessageToSign.SAMLResponse = samlMessage.SAMLResponse;
    }
    if (samlMessage.RelayState) {
      samlMessageToSign.RelayState = samlMessage.RelayState;
    }
    if (samlMessage.SigAlg) {
      samlMessageToSign.SigAlg = samlMessage.SigAlg;
    }
    signer.update(querystring.stringify(samlMessageToSign));
    samlMessage.Signature = signer.sign(this.keyToPEM(this.options.privateCert), 'base64');
  }

  generateAuthorizeRequest(req, isPassive, isHttpPostBinding, callback) {
    const id = `_${this.generateUniqueID()}`;
    const instant = this.generateInstant();
    const forceAuthn = this.options.forceAuthn || false;

    (async () => {
      if(this.options.validateInResponseTo) {
        const saveFn = promisify(this.cacheProvider.save).bind(this.cacheProvider);
        return await saveFn(id, instant);
      } else {
        return;
      }
    })()
    .then(() => {
      const request = {
        'samlp:AuthnRequest': {
          '@xmlns:samlp': 'urn:oasis:names:tc:SAML:2.0:protocol',
          '@ID': id,
          '@Version': '2.0',
          '@IssueInstant': instant,
          '@ProtocolBinding': 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST',
          '@Destination': this.options.entryPoint,
          'saml:Issuer' : {
            '@xmlns:saml' : 'urn:oasis:names:tc:SAML:2.0:assertion',
            '#text': this.options.issuer
          }
        }
      };

      if (isPassive)
        request['samlp:AuthnRequest']['@IsPassive'] = true;

      if (forceAuthn) {
        request['samlp:AuthnRequest']['@ForceAuthn'] = true;
      }

      if (!this.options.disableRequestACSUrl) {
        request['samlp:AuthnRequest']['@AssertionConsumerServiceURL'] = this.getCallbackUrl(req);
      }

      if (this.options.identifierFormat) {
        request['samlp:AuthnRequest']['samlp:NameIDPolicy'] = {
          '@xmlns:samlp': 'urn:oasis:names:tc:SAML:2.0:protocol',
          '@Format': this.options.identifierFormat,
          '@AllowCreate': 'true'
        };
      }

      if (!this.options.disableRequestedAuthnContext) {
        const authnContextClassRefs = [];
        this.options.authnContext.forEach(value => {
          authnContextClassRefs.push({
              '@xmlns:saml': 'urn:oasis:names:tc:SAML:2.0:assertion',
              '#text': value
          });
        });

        request['samlp:AuthnRequest']['samlp:RequestedAuthnContext'] = {
          '@xmlns:samlp': 'urn:oasis:names:tc:SAML:2.0:protocol',
          '@Comparison': this.options.RACComparison,
          'saml:AuthnContextClassRef': authnContextClassRefs
        };
      }

      if (this.options.attributeConsumingServiceIndex != null) {
        request['samlp:AuthnRequest']['@AttributeConsumingServiceIndex'] = this.options.attributeConsumingServiceIndex;
      }

      if (this.options.providerName) {
        request['samlp:AuthnRequest']['@ProviderName'] = this.options.providerName;
      }

      let stringRequest = xmlbuilder.create(request).end();
      if (isHttpPostBinding && this.options.privateCert) {
        stringRequest = signAuthnRequestPost(stringRequest, this.options);
      }
      callback(null, stringRequest);
    })
    .catch(err => {
      callback(err);
    });
  }

  async generateLogoutRequest({user}) {
    const id = `_${this.generateUniqueID()}`;
    const instant = this.generateInstant();

    const request = {
      'samlp:LogoutRequest' : {
        '@xmlns:samlp': 'urn:oasis:names:tc:SAML:2.0:protocol',
        '@xmlns:saml': 'urn:oasis:names:tc:SAML:2.0:assertion',
        '@ID': id,
        '@Version': '2.0',
        '@IssueInstant': instant,
        '@Destination': this.options.logoutUrl,
        'saml:Issuer' : {
          '@xmlns:saml': 'urn:oasis:names:tc:SAML:2.0:assertion',
          '#text': this.options.issuer
        },
        'saml:NameID' : {
          '@Format': user.nameIDFormat,
          '#text': user.nameID
        }
      }
    };

    if (user.nameQualifier != null) {
      request['samlp:LogoutRequest']['saml:NameID']['@NameQualifier'] = user.nameQualifier;
    }

    if (user.spNameQualifier != null) {
      request['samlp:LogoutRequest']['saml:NameID']['@SPNameQualifier'] = user.spNameQualifier;
    }

    if (user.sessionIndex) {
      request['samlp:LogoutRequest']['saml2p:SessionIndex'] = {
        '@xmlns:saml2p': 'urn:oasis:names:tc:SAML:2.0:protocol',
        '#text': user.sessionIndex
      };
    }
    const saveFn = promisify(this.cacheProvider.save).bind(this.cacheProvider);
    await saveFn(id, instant);
    return xmlbuilder.create(request).end();
  }

  generateLogoutResponse(req, {ID}) {
    const id = `_${this.generateUniqueID()}`;
    const instant = this.generateInstant();

    const request = {
      'samlp:LogoutResponse' : {
        '@xmlns:samlp': 'urn:oasis:names:tc:SAML:2.0:protocol',
        '@xmlns:saml': 'urn:oasis:names:tc:SAML:2.0:assertion',
        '@ID': id,
        '@Version': '2.0',
        '@IssueInstant': instant,
        '@Destination': this.options.logoutUrl,
        '@InResponseTo': ID,
        'saml:Issuer' : {
          '#text': this.options.issuer
        },
        'samlp:Status': {
          'samlp:StatusCode': {
            '@Value': 'urn:oasis:names:tc:SAML:2.0:status:Success'
          }
        }
      }
    };

    return xmlbuilder.create(request).end();
  }

  requestToUrl(request, response, operation, additionalParameters, callback) {

    const requestToUrlHelper = (err, buffer) => {
      if (err) {
        return callback(err);
      }

      const base64 = buffer.toString('base64');
      let target = url.parse(this.options.entryPoint, true);

      if (operation === 'logout') {
        if (this.options.logoutUrl) {
          target = url.parse(this.options.logoutUrl, true);
        }
      } else if (operation !== 'authorize') {
          return callback(new Error(`Unknown operation: ${operation}`));
      }

      const samlMessage = request ? {
        SAMLRequest: base64
      } : {
        SAMLResponse: base64
      };
      Object.keys(additionalParameters).forEach(k => {
        samlMessage[k] = additionalParameters[k];
      });

      if (this.options.privateCert) {
        try {
          if (!this.options.entryPoint) {
            throw new Error('"entryPoint" config parameter is required for signed messages');
          }

          // sets .SigAlg and .Signature
          this.signRequest(samlMessage);

        } catch (ex) {
          return callback(ex);
        }
      }
      Object.keys(samlMessage).forEach(k => {
        target.query[k] = samlMessage[k];
      });

      // Delete 'search' to for pulling query string from 'query'
      // https://nodejs.org/api/url.html#url_url_format_urlobj
      delete target.search;

      callback(null, url.format(target));
    };

    if (this.options.skipRequestCompression) {
      requestToUrlHelper(null, Buffer.from(request || response, 'utf8'));
    }
    else {
      zlib.deflateRaw(request || response, requestToUrlHelper);
    }
  }

  getAdditionalParams({query, body}, operation, overrideParams) {
    const additionalParams = {};

    const RelayState = query && query.RelayState || body && body.RelayState;
    if (RelayState) {
      additionalParams.RelayState = RelayState;
    }

    const optionsAdditionalParams = this.options.additionalParams || {};
    Object.keys(optionsAdditionalParams).forEach(k => {
      additionalParams[k] = optionsAdditionalParams[k];
    });

    let optionsAdditionalParamsForThisOperation = {};
    if (operation == "authorize") {
      optionsAdditionalParamsForThisOperation = this.options.additionalAuthorizeParams || {};
    }
    if (operation == "logout") {
      optionsAdditionalParamsForThisOperation = this.options.additionalLogoutParams || {};
    }

    Object.keys(optionsAdditionalParamsForThisOperation).forEach(k => {
      additionalParams[k] = optionsAdditionalParamsForThisOperation[k];
    });

    overrideParams = overrideParams || {};
    Object.keys(overrideParams).forEach(k => {
      additionalParams[k] = overrideParams[k];
    });

    return additionalParams;
  }

  getAuthorizeUrl(req, options, callback) {
    this.generateAuthorizeRequest(req, this.options.passive, false, (err, request) => {
      if (err)
        return callback(err);
      const operation = 'authorize';
      const overrideParams = options ? options.additionalParams || {} : {};
      this.requestToUrl(request, null, operation, this.getAdditionalParams(req, operation, overrideParams), callback);
    });
  }

  getAuthorizeForm(req, callback) {
    // The quoteattr() function is used in a context, where the result will not be evaluated by javascript
    // but must be interpreted by an XML or HTML parser, and it must absolutely avoid breaking the syntax
    // of an element attribute.
    const quoteattr = (s, preserveCR) => {
      preserveCR = preserveCR ? '&#13;' : '\n';
      return (`${s}`) // Forces the conversion to string.
        .replace(/&/g, '&amp;') // This MUST be the 1st replacement.
        .replace(/'/g, '&apos;') // The 4 other predefined entities, required.
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
         // Add other replacements here for HTML only
         // Or for XML, only if the named entities are defined in its DTD.
        .replace(/\r\n/g, preserveCR) // Must be before the next replacement.
        .replace(/[\r\n]/g, preserveCR);
    };

    const getAuthorizeFormHelper = (err, buffer) => {
      if (err) {
        return callback(err);
      }

      const operation = 'authorize';
      const additionalParameters = this.getAdditionalParams(req, operation);
      const samlMessage = {
        SAMLRequest: buffer.toString('base64')
      };

      Object.keys(additionalParameters).forEach(k => {
        samlMessage[k] = additionalParameters[k] || '';
      });

      const formInputs = Object.keys(samlMessage).map(k => `<input type="hidden" name="${k}" value="${quoteattr(samlMessage[k])}" />`).join('\r\n');

      callback(null, [
        '<!DOCTYPE html>',
        '<html>',
        '<head>',
        '<meta charset="utf-8">',
        '<meta http-equiv="x-ua-compatible" content="ie=edge">',
        '</head>',
        '<body onload="document.forms[0].submit()">',
        '<noscript>',
        '<p><strong>Note:</strong> Since your browser does not support JavaScript, you must press the button below once to proceed.</p>',
        '</noscript>',
        `<form method="post" action="${encodeURI(this.options.entryPoint)}">`,
        formInputs,
        '<input type="submit" value="Submit" />',
        '</form>',
        '<script>document.forms[0].style.display="none";</script>', // Hide the form if JavaScript is enabled
        '</body>',
        '</html>'
      ].join('\r\n'));
    };

    this.generateAuthorizeRequest(req, this.options.passive, true, (err, request) => {
      if (err) {
        return callback(err);
      }

      if (this.options.skipRequestCompression) {
        getAuthorizeFormHelper(null, Buffer.from(request, 'utf8'));
      } else {
        zlib.deflateRaw(request, getAuthorizeFormHelper);
      }
    });

  }

  getLogoutUrl(req, options, callback) {
    return this.generateLogoutRequest(req)
      .then(request => {
        const operation = 'logout';
        const overrideParams = options ? options.additionalParams || {} : {};
        return this.requestToUrl(request, null, operation, this.getAdditionalParams(req, operation, overrideParams), callback);
      });
  }

  getLogoutResponseUrl(req, options, callback) {
    const response = this.generateLogoutResponse(req, req.samlLogoutRequest);
    const operation = 'logout';
    const overrideParams = options ? options.additionalParams || {} : {};
    this.requestToUrl(null, response, operation, this.getAdditionalParams(req, operation, overrideParams), callback);
  }

  certToPEM(cert) {
    cert = cert.match(/.{1,64}/g).join('\n');

    if (!cert.includes('-BEGIN CERTIFICATE-'))
      cert = `-----BEGIN CERTIFICATE-----\n${cert}`;
    if (!cert.includes('-END CERTIFICATE-'))
      cert = `${cert}\n-----END CERTIFICATE-----\n`;

    return cert;
  }

  async certsToCheck() {
    if (!this.options.cert) {
      return;
    }
    if (typeof(this.options.cert) === 'function') {
      let certs = await promisify(this.options.cert)();
      if (!Array.isArray(certs)) {
        certs = [certs];
      }
      return certs;
    }
    let certs = this.options.cert;
    if (!Array.isArray(certs)) {
      certs = [certs];
    }
    return certs;
  }

  // This function checks that the |currentNode| in the |fullXml| document contains exactly 1 valid
  //   signature of the |currentNode|.
  //
  // See https://github.com/bergie/passport-saml/issues/19 for references to some of the attack
  //   vectors against SAML signature verification.
  validateSignature(fullXml, currentNode, certs) {
    const xpathSigQuery = ".//*[local-name(.)='Signature' and " +
                        "namespace-uri(.)='http://www.w3.org/2000/09/xmldsig#']";
    const signatures = xpath(currentNode, xpathSigQuery);
    // This function is expecting to validate exactly one signature, so if we find more or fewer
    //   than that, reject.
    if (signatures.length != 1) {
      return false;
    }

    const signature = signatures[0];
    return certs.some(certToCheck => this.validateSignatureForCert(signature, certToCheck, fullXml, currentNode));
  }

  // This function checks that the |signature| is signed with a given |cert|.
  validateSignatureForCert(signature, cert, fullXml, currentNode) {
    const sig = new xmlCrypto.SignedXml();
    sig.keyInfoProvider = {
      getKeyInfo: key => "<X509Data></X509Data>",
      getKey: keyInfo => this.certToPEM(cert),
    };
    sig.loadSignature(signature);
    // We expect each signature to contain exactly one reference to the top level of the xml we
    //   are validating, so if we see anything else, reject.
    if (sig.references.length != 1 )
      return false;
    const refUri = sig.references[0].uri;
    const refId = (refUri[0] === '#') ? refUri.substring(1) : refUri;
    // If we can't find the reference at the top level, reject
    const idAttribute = currentNode.getAttribute('ID') ? 'ID' : 'Id';
    if (currentNode.getAttribute(idAttribute) != refId)
      return false;
    // If we find any extra referenced nodes, reject.  (xml-crypto only verifies one digest, so
    //   multiple candidate references is bad news)
    const totalReferencedNodes = xpath(currentNode.ownerDocument,
                                    `//*[@${idAttribute}='${refId}']`);

    if (totalReferencedNodes.length > 1) {
      return false;
    }
    return sig.checkSignature(fullXml);
  }

  validatePostResponse({SAMLResponse}, callback) {
    let xml;
    let doc;
    let inResponseTo;

    (async () => {
      xml = Buffer.from(SAMLResponse, 'base64').toString('utf8');
      doc = new xmldom.DOMParser({
      }).parseFromString(xml);

      if (!Object.prototype.hasOwnProperty.call(doc, 'documentElement'))
        throw new Error('SAMLResponse is not valid base64-encoded XML');

      inResponseTo = xpath(doc, "/*[local-name()='Response']/@InResponseTo");

      if (inResponseTo) {
        inResponseTo = inResponseTo.length ? inResponseTo[0].nodeValue : null;

        return this.validateInResponseTo(inResponseTo);
      }
    })()
    .then(() => this.certsToCheck())
    .then(async certs => {
      // Check if this document has a valid top-level signature
      let validSignature = false;
      if (this.options.cert && this.validateSignature(xml, doc.documentElement, certs)) {
        validSignature = true;
      }

      const assertions = xpath(doc, "/*[local-name()='Response']/*[local-name()='Assertion']");
      const encryptedAssertions = xpath(doc,
                                      "/*[local-name()='Response']/*[local-name()='EncryptedAssertion']");

      if (assertions.length + encryptedAssertions.length > 1) {
        // There's no reason I know of that we want to handle multiple assertions, and it seems like a
        //   potential risk vector for signature scope issues, so treat this as an invalid signature
        throw new Error('Invalid signature: multiple assertions');
      }

      if (assertions.length == 1) {
        if (this.options.cert &&
            !validSignature &&
              !this.validateSignature(xml, assertions[0], certs)) {
          throw new Error('Invalid signature');
        }
        return this.processValidlySignedAssertion(assertions[0].toString(), xml, inResponseTo, callback);
      }

      if (encryptedAssertions.length == 1) {
        if (!this.options.decryptionPvk)
          throw new Error('No decryption key for encrypted SAML response');

        const encryptedAssertionXml = encryptedAssertions[0].toString();

        const xmlencOptions = { key: this.options.decryptionPvk };
        const decryptFn = promisify(xmlenc.decrypt).bind(xmlenc);
        const decryptedXml = await decryptFn(encryptedAssertionXml, xmlencOptions);
        const decryptedDoc = new xmldom.DOMParser().parseFromString(decryptedXml);
        const decryptedAssertions = xpath(decryptedDoc, "/*[local-name()='Assertion']");
        if (decryptedAssertions.length != 1)
          throw new Error('Invalid EncryptedAssertion content');

        if (this.options.cert &&
            !validSignature &&
              !this.validateSignature(decryptedXml, decryptedAssertions[0], certs))
          throw new Error('Invalid signature from encrypted assertion');

        this.processValidlySignedAssertion(decryptedAssertions[0].toString(), xml, inResponseTo, callback);
        return;
      }

      // If there's no assertion, fall back on xml2js response parsing for the status &
      //   LogoutResponse code.

      const parserConfig = {
        explicitRoot: true,
        explicitCharkey: true,
        tagNameProcessors: [xml2js.processors.stripPrefix]
      };
      const parser = new xml2js.Parser(parserConfig);
      const doc2 = await parser.parseStringPromise(xml);
      const response = doc2.Response;
      if (response) {
        const assertion = response.Assertion;
        if (!assertion) {
          const status = response.Status;
          if (status) {
            const statusCode = status[0].StatusCode;
            if (statusCode && statusCode[0].$.Value === "urn:oasis:names:tc:SAML:2.0:status:Responder") {
              const nestedStatusCode = statusCode[0].StatusCode;
              if (nestedStatusCode && nestedStatusCode[0].$.Value === "urn:oasis:names:tc:SAML:2.0:status:NoPassive") {
                if (this.options.cert && !validSignature) {
                  throw new Error('Invalid signature: NoPassive');
                }
                return callback(null, null, false);
              }
            }

            // Note that we're not requiring a valid signature before this logic -- since we are
            //   throwing an error in any case, and some providers don't sign error results,
            //   let's go ahead and give the potentially more helpful error.
            if (statusCode && statusCode[0].$.Value) {
              const msgType = statusCode[0].$.Value.match(/[^:]*$/)[0];
              if (msgType != 'Success') {
                  let msg = 'unspecified';
                  if (status[0].StatusMessage) {
                    msg = status[0].StatusMessage[0]._;
                  } else if (statusCode[0].StatusCode) {
                    msg = statusCode[0].StatusCode[0].$.Value.match(/[^:]*$/)[0];
                  }
                  const error = new Error(`SAML provider returned ${msgType} error: ${msg}`);
                  const builderOpts = {
                    rootName: 'Status',
                    headless: true
                  };
                  error.statusXml = new xml2js.Builder(builderOpts).buildObject(status[0]);
                  throw error;
                }
              }
            }
            throw new Error('Missing SAML assertion');
          }
        } else {
          if (this.options.cert && !validSignature) {
            throw new Error('Invalid signature: No response found');
          }
          const logoutResponse = doc2.LogoutResponse;
          if (logoutResponse){
            return callback(null, null, true);
          } else {
            throw new Error('Unknown SAML response message');
          }
        }
    })
    .catch(async err => {
      debug('validatePostResponse resulted in an error: %s', err);
      if (this.options.validateInResponseTo) {
        const removeFn = promisify(this.cacheProvider.remove).bind(this.cacheProvider);
        await removeFn(inResponseTo);
        callback(err);
      } else {
        callback(err);
      }
    });
  }

  async validateInResponseTo(inResponseTo) {
    if (this.options.validateInResponseTo) {
      if (inResponseTo) {
        const getFn = promisify(this.cacheProvider.get).bind(this.cacheProvider);
        const result = await getFn(inResponseTo);
        if (!result)
          throw new Error('InResponseTo is not valid');
        return;
      } else {
        throw new Error('InResponseTo is missing from response');
      }
    } else {
      return;
    }
  }

  validateRedirect(container, originalQuery, callback) {
    const samlMessageType = container.SAMLRequest ? 'SAMLRequest' : 'SAMLResponse';

    const data = Buffer.from(container[samlMessageType], "base64");
    zlib.inflateRaw(data, (err, inflated) => {
      if (err) {
        return callback(err);
      }

      const dom = new xmldom.DOMParser().parseFromString(inflated.toString());
      const parserConfig = {
        explicitRoot: true,
        explicitCharkey: true,
        tagNameProcessors: [xml2js.processors.stripPrefix]
      };
      const parser = new xml2js.Parser(parserConfig);
      parser.parseString(inflated, (err, doc) => {
        if (err) {
          return callback(err);
        }

        (async () => samlMessageType === 'SAMLResponse' ?
          this.verifyLogoutResponse(doc) : this.verifyLogoutRequest(doc))()
        .then(() => this.hasValidSignatureForRedirect(container, originalQuery))
        .then(() => processValidlySignedSamlLogout(this, doc, dom, callback))
        .catch(err => callback(err));
      });
    });
  }

  hasValidSignatureForRedirect({Signature, SigAlg}, originalQuery) {
    const tokens = originalQuery.split('&');
    const getParam = key => {
      const exists = tokens.filter(t => new RegExp(key).test(t));
      return exists[0];
    };

    if (Signature && this.options.cert) {
      let urlString = getParam('SAMLRequest') || getParam('SAMLResponse');

      if (getParam('RelayState')) {
        urlString += `&${getParam('RelayState')}`;
      }

      urlString += `&${getParam('SigAlg')}`;

      return this.certsToCheck()
        .then(certs => {
          const hasValidQuerySignature = certs.some(cert => this.validateSignatureForRedirect(
            urlString, Signature, SigAlg, cert
          ));

          if (!hasValidQuerySignature) {
            throw 'Invalid signature';
          }
        });
    } else {
      return Promise.resolve(true);
    }
  }

  validateSignatureForRedirect(urlString, signature, alg, cert) {
    // See if we support a matching algorithm, case-insensitive. Otherwise, throw error.
    function hasMatch (ourAlgo) {
      // The incoming algorithm is forwarded as a URL.
      // We trim everything before the last # get something we can compare to the Node.js list
      const algFromURI = alg.toLowerCase().replace(/.*#(.*)$/,'$1');
      return ourAlgo.toLowerCase() === algFromURI;
    }
    let i = crypto.getHashes().findIndex(hasMatch);
    let matchingAlgo;
    if (i > -1) {
      matchingAlgo = crypto.getHashes()[i];
    }
    else {
      throw `${alg} is not supported`;
    }

    const verifier = crypto.createVerify(matchingAlgo);
    verifier.update(urlString);

    return verifier.verify(this.certToPEM(cert), signature, 'base64');
  }

  verifyLogoutRequest({LogoutRequest}) {
    this.verifyIssuer(LogoutRequest);
    const nowMs = new Date().getTime();
    const conditions = LogoutRequest.$;
    const conErr = this.checkTimestampsValidityError(
      nowMs, conditions.NotBefore, conditions.NotOnOrAfter
    );
    if (conErr) {
      throw conErr;
    }
  }

  verifyLogoutResponse({LogoutResponse}) {
    return (async () => {
      const statusCode = LogoutResponse.Status[0].StatusCode[0].$.Value;
      if (statusCode !== "urn:oasis:names:tc:SAML:2.0:status:Success")
        throw `Bad status code: ${statusCode}`;

      this.verifyIssuer(LogoutResponse);
      const inResponseTo = LogoutResponse.$.InResponseTo;
      if (inResponseTo) {
        return this.validateInResponseTo(inResponseTo);
      }

      return Promise.resolve(true);
    })();
  }

  verifyIssuer({Issuer}) {
    if(this.options.idpIssuer) {
      const issuer = Issuer;
      if (issuer) {
        if (issuer[0]._ !== this.options.idpIssuer)
          throw `Unknown SAML issuer. Expected: ${this.options.idpIssuer} Received: ${issuer[0]._}`;
      } else {
        throw 'Missing SAML issuer';
      }
    }
  }

  processValidlySignedAssertion(xml, samlResponseXml, inResponseTo, callback) {
    let msg;
    const parserConfig = {
      explicitRoot: true,
      explicitCharkey: true,
      tagNameProcessors: [xml2js.processors.stripPrefix]
    };
    const nowMs = new Date().getTime();
    const profile = {};
    let assertion;
    let parsedAssertion;
    const parser = new xml2js.Parser(parserConfig);
    parser.parseStringPromise(xml)
    .then(doc => {
      parsedAssertion = doc;
      assertion = doc.Assertion;

      const issuer = assertion.Issuer;
      if (issuer && issuer[0]._) {
        profile.issuer = issuer[0]._;
      }

      if (inResponseTo) {
        profile.inResponseTo = inResponseTo;
      }

      const authnStatement = assertion.AuthnStatement;
      if (authnStatement) {
        if (authnStatement[0].$ && authnStatement[0].$.SessionIndex) {
          profile.sessionIndex = authnStatement[0].$.SessionIndex;
        }
      }

      const subject = assertion.Subject;
      let subjectConfirmation;
      let confirmData;
      if (subject) {
        const nameID = subject[0].NameID;
        if (nameID && nameID[0]._) {
          profile.nameID = nameID[0]._;

          if (nameID[0].$ && nameID[0].$.Format) {
            profile.nameIDFormat = nameID[0].$.Format;
            profile.nameQualifier = nameID[0].$.NameQualifier;
            profile.spNameQualifier = nameID[0].$.SPNameQualifier;
          }
        }

        subjectConfirmation = subject[0].SubjectConfirmation ?
                              subject[0].SubjectConfirmation[0] : null;
        confirmData = subjectConfirmation && subjectConfirmation.SubjectConfirmationData ?
                      subjectConfirmation.SubjectConfirmationData[0] : null;
        if (subject[0].SubjectConfirmation && subject[0].SubjectConfirmation.length > 1) {
          msg = 'Unable to process multiple SubjectConfirmations in SAML assertion';
          throw new Error(msg);
        }

        if (subjectConfirmation) {
          if (confirmData && confirmData.$) {
            const subjectNotBefore = confirmData.$.NotBefore;
            const subjectNotOnOrAfter = confirmData.$.NotOnOrAfter;

            const subjErr = this.checkTimestampsValidityError(
                            nowMs, subjectNotBefore, subjectNotOnOrAfter);
            if (subjErr) {
              throw subjErr;
            }
          }
        }
      }

      // Test to see that if we have a SubjectConfirmation InResponseTo that it matches
      // the 'InResponseTo' attribute set in the Response
      if (this.options.validateInResponseTo) {
        const removeFn = promisify(this.cacheProvider.remove).bind(this.cacheProvider);
        const getFn = promisify(this.cacheProvider.get).bind(this.cacheProvider);
        if (subjectConfirmation) {
          if (confirmData && confirmData.$) {
            const subjectInResponseTo = confirmData.$.InResponseTo;
            if (inResponseTo && subjectInResponseTo && subjectInResponseTo != inResponseTo) {
              return removeFn(inResponseTo)
                .then(() => {
                  throw new Error('InResponseTo is not valid');
                });
            } else if (subjectInResponseTo) {
              let foundValidInResponseTo = false;

              return getFn(subjectInResponseTo)
                .then(result => {
                  if (result) {
                    const createdAt = new Date(result);
                    if (nowMs < createdAt.getTime() + this.options.requestIdExpirationPeriodMs)
                      foundValidInResponseTo = true;
                  }
                  return removeFn(inResponseTo);
                })
                .then(() => {
                  if (!foundValidInResponseTo) {
                    throw new Error('InResponseTo is not valid');
                  }
                  return Promise.resolve();
                });
            }
          }
        } else {
          return removeFn(inResponseTo);
        }
      } else {
        return Promise.resolve();
      }
    })
    .then(() => {
      const conditions = assertion.Conditions ? assertion.Conditions[0] : null;
      if (assertion.Conditions && assertion.Conditions.length > 1) {
        msg = 'Unable to process multiple conditions in SAML assertion';
        throw new Error(msg);
      }
      if(conditions && conditions.$) {
        const conErr = this.checkTimestampsValidityError(
                      nowMs, conditions.$.NotBefore, conditions.$.NotOnOrAfter);
        if(conErr)
          throw conErr;
      }

      if (this.options.audience) {
        const audienceErr = this.checkAudienceValidityError(
                      this.options.audience, conditions.AudienceRestriction);
        if(audienceErr)
          throw audienceErr;
      }

      const attributeStatement = assertion.AttributeStatement;
      if (attributeStatement) {
        const attributes = [].concat(...attributeStatement.filter(({Attribute}) => Array.isArray(Attribute))
                          .map(({Attribute}) => Attribute));

        const attrValueMapper = value => typeof value === 'string' ? value : value._;

        if (attributes) {
          attributes.forEach(attribute => {
           if(!Object.prototype.hasOwnProperty.call(attribute, 'AttributeValue')) {
              // if attributes has no AttributeValue child, continue
              return;
            }
            const value = attribute.AttributeValue;
            if (value.length === 1) {
              profile[attribute.$.Name] = attrValueMapper(value[0]);
            } else {
              profile[attribute.$.Name] = value.map(attrValueMapper);
            }
          });
        }
      }

      if (!profile.mail && profile['urn:oid:0.9.2342.19200300.100.1.3']) {
        // See https://spaces.internet2.edu/display/InCFederation/Supported+Attribute+Summary
        // for definition of attribute OIDs
        profile.mail = profile['urn:oid:0.9.2342.19200300.100.1.3'];
      }

      if (!profile.email && profile.mail) {
        profile.email = profile.mail;
      }

      profile.getAssertionXml = () => xml;
      profile.getAssertion = () => parsedAssertion;
      profile.getSamlResponseXml = () => samlResponseXml;

      callback(null, profile, false);
    })
    .catch(err => callback(err));
  }

  checkTimestampsValidityError(nowMs, notBefore, notOnOrAfter) {
    if (this.options.acceptedClockSkewMs == -1)
        return null;

    if (notBefore) {
      const notBeforeMs = Date.parse(notBefore);
      if (nowMs + this.options.acceptedClockSkewMs < notBeforeMs)
          return new Error('SAML assertion not yet valid');
    }
    if (notOnOrAfter) {
      const notOnOrAfterMs = Date.parse(notOnOrAfter);
      if (nowMs - this.options.acceptedClockSkewMs >= notOnOrAfterMs)
        return new Error('SAML assertion expired');
    }

    return null;
  }

  checkAudienceValidityError(expectedAudience, audienceRestrictions) {
    if (!audienceRestrictions || audienceRestrictions.length < 1) {
      return new Error('SAML assertion has no AudienceRestriction');
    }
    const errors = audienceRestrictions.map(({Audience}) => {
      if (!Audience || !Audience[0] || !Audience[0]._) {
        return new Error('SAML assertion AudienceRestriction has no Audience value');
      }
      if (Audience[0]._ !== expectedAudience) {
        return new Error('SAML assertion audience mismatch');
      }
      return null;
    }).filter(result => result !== null);
    if (errors.length > 0) {
      return errors[0];
    }
    return null;
  }

  validatePostRequest({SAMLRequest}, callback) {
    const xml = Buffer.from(SAMLRequest, 'base64').toString('utf8');
    const dom = new xmldom.DOMParser().parseFromString(xml);
    const parserConfig = {
      explicitRoot: true,
      explicitCharkey: true,
      tagNameProcessors: [xml2js.processors.stripPrefix]
    };
    const parser = new xml2js.Parser(parserConfig);
    parser.parseString(xml, (err, doc) => {
      if (err) {
        return callback(err);
      }

      this.certsToCheck()
      .then(certs => {
        // Check if this document has a valid top-level signature
        if (this.options.cert && !this.validateSignature(xml, dom.documentElement, certs)) {
          return callback(new Error('Invalid signature on documentElement'));
        }

        processValidlySignedPostRequest(this, doc, dom, callback);
      })
      .catch(err => callback(err));
    });
  }

  getNameID({options}, doc, callback) {
    const nameIds = xpath(doc, "/*[local-name()='LogoutRequest']/*[local-name()='NameID']");
    const encryptedIds = xpath(doc,
      "/*[local-name()='LogoutRequest']/*[local-name()='EncryptedID']");

    if (nameIds.length + encryptedIds.length > 1) {
      return callback(new Error('Invalid LogoutRequest'));
    }
    if (nameIds.length === 1) {
      return callBackWithNameID(nameIds[0], callback);
    }
    if (encryptedIds.length === 1) {
      if (!options.decryptionPvk) {
        return callback(new Error('No decryption key for encrypted SAML response'));
      }

      const encryptedDatas = xpath(encryptedIds[0], "./*[local-name()='EncryptedData']");

      if (encryptedDatas.length !== 1) {
        return callback(new Error('Invalid LogoutRequest'));
      }
      const encryptedDataXml = encryptedDatas[0].toString();

      const xmlencOptions = { key: options.decryptionPvk };
      const decryptFn = promisify(xmlenc.decrypt).bind(xmlenc);
      return decryptFn(encryptedDataXml, xmlencOptions)
        .then(decryptedXml => {
          const decryptedDoc = new xmldom.DOMParser().parseFromString(decryptedXml);
          const decryptedIds = xpath(decryptedDoc, "/*[local-name()='NameID']");
          if (decryptedIds.length !== 1) {
            return callback(new Error('Invalid EncryptedAssertion content'));
          }
          return callBackWithNameID(decryptedIds[0], callback);
        });
    }
    callback(new Error('Missing SAML NameID'));
  }

  generateServiceProviderMetadata(decryptionCert, signingCert) {
    const metadata = {
      'EntityDescriptor' : {
        '@xmlns': 'urn:oasis:names:tc:SAML:2.0:metadata',
        '@xmlns:ds': 'http://www.w3.org/2000/09/xmldsig#',
        '@entityID': this.options.issuer,
        '@ID': this.options.issuer.replace(/\W/g, '_'),
        'SPSSODescriptor' : {
          '@protocolSupportEnumeration': 'urn:oasis:names:tc:SAML:2.0:protocol',
        },
      }
    };

    if (this.options.decryptionPvk) {
      if (!decryptionCert) {
        throw new Error(
          "Missing decryptionCert while generating metadata for decrypting service provider");
      }
    }

    if(this.options.privateCert){
      if(!signingCert){
        throw new Error(
          "Missing signingCert while generating metadata for signing service provider messages");
      }
    }

    if(this.options.decryptionPvk || this.options.privateCert){
      metadata.EntityDescriptor.SPSSODescriptor.KeyDescriptor=[];
      if (this.options.privateCert) {

        signingCert = signingCert.replace( /-+BEGIN CERTIFICATE-+\r?\n?/, '' );
        signingCert = signingCert.replace( /-+END CERTIFICATE-+\r?\n?/, '' );
        signingCert = signingCert.replace( /\r\n/g, '\n' );

        metadata.EntityDescriptor.SPSSODescriptor.KeyDescriptor.push({
          '@use': 'signing',
          'ds:KeyInfo' : {
            'ds:X509Data' : {
              'ds:X509Certificate': {
                '#text': signingCert
              }
            }
          }
        });
      }

      if (this.options.decryptionPvk) {

        decryptionCert = decryptionCert.replace( /-+BEGIN CERTIFICATE-+\r?\n?/, '' );
        decryptionCert = decryptionCert.replace( /-+END CERTIFICATE-+\r?\n?/, '' );
        decryptionCert = decryptionCert.replace( /\r\n/g, '\n' );

        metadata.EntityDescriptor.SPSSODescriptor.KeyDescriptor.push({
          '@use': 'encryption',
          'ds:KeyInfo' : {
            'ds:X509Data' : {
              'ds:X509Certificate': {
                '#text': decryptionCert
              }
            }
          },
          'EncryptionMethod' : [
            // this should be the set that the xmlenc library supports
            { '@Algorithm': 'http://www.w3.org/2001/04/xmlenc#aes256-cbc' },
            { '@Algorithm': 'http://www.w3.org/2001/04/xmlenc#aes128-cbc' },
            { '@Algorithm': 'http://www.w3.org/2001/04/xmlenc#tripledes-cbc' }
          ]
        });
      }
    }

    if (this.options.logoutCallbackUrl) {
      metadata.EntityDescriptor.SPSSODescriptor.SingleLogoutService = {
        '@Binding': 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST',
        '@Location': this.options.logoutCallbackUrl
      };
    }

    if (this.options.identifierFormat) {
      metadata.EntityDescriptor.SPSSODescriptor.NameIDFormat = this.options.identifierFormat;
    }

    metadata.EntityDescriptor.SPSSODescriptor.AssertionConsumerService = {
      '@index': '1',
      '@isDefault': 'true',
      '@Binding': 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST',
      '@Location': this.getCallbackUrl({})
    };
    return xmlbuilder.create(metadata).end({ pretty: true, indent: '  ', newline: '\n' });
  }

  keyToPEM(key) {
    if (!key || typeof key !== 'string') return key;

    const lines = key.split('\n');
    if (lines.length !== 1) return key;

    const wrappedKey = [
      '-----BEGIN PRIVATE KEY-----',
      ...key.match(/.{1,64}/g),
      '-----END PRIVATE KEY-----',
      ''
    ].join('\n');
    return wrappedKey;
  }
}

function processValidlySignedSamlLogout(self, doc, dom, callback) {
  const response = doc.LogoutResponse;
  const request = doc.LogoutRequest;

  if (response){
    return callback(null, null, true);
  } else if (request) {
    processValidlySignedPostRequest(self, doc, dom, callback);
  } else {
    throw new Error('Unknown SAML response message');
  }
}

function callBackWithNameID(nameid, callback) {
  const format = xpath(nameid, "@Format");
  return callback(null, {
    value: nameid.textContent,
    format: format && format[0] && format[0].nodeValue
  });
}

function processValidlySignedPostRequest(self, {LogoutRequest}, dom, callback) {
    const request = LogoutRequest;
    if (request) {
      const profile = {};
      if (request.$.ID) {
          profile.ID = request.$.ID;
      } else {
        return callback(new Error('Missing SAML LogoutRequest ID'));
      }
      const issuer = request.Issuer;
      if (issuer && issuer[0]._) {
        profile.issuer = issuer[0]._;
      } else {
        return callback(new Error('Missing SAML issuer'));
      }
      self.getNameID(self, dom, (err, nameID) => {
        if(err) {
          return callback(err);
        }

        if (nameID) {
          profile.nameID = nameID.value;
          if (nameID.format) {
            profile.nameIDFormat = nameID.format;
          }
        } else {
          return callback(new Error('Missing SAML NameID'));
        }
        const sessionIndex = request.SessionIndex;
        if (sessionIndex) {
          profile.sessionIndex = sessionIndex[0]._;
        }
        callback(null, profile, true);
      });
    } else {
      return callback(new Error('Unknown SAML request message'));
    }
}

exports.SAML = SAML;