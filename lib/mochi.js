/* globals gauge*/
"use strict";
const axios = require('axios');
const curlirize = require('axios-curlirize');
const curlToPostman = require('curl-to-postmanv2/src/lib');
const fs = require("fs");
const { JSONPath } = require('jsonpath-plus');
const url = require('url');

const store = gauge.dataStore.scenarioStore;

module.exports = {
    createRequest: createRequest,
    fillUserDefinedVars: fillUserDefinedVars
};

function createRequest(request, options = {}) {
    //request format {curl,request,response,execute(doWhile),options: {silent,nofile,fullresponse}
    var ret = {};
    if (options.silent === true)
        ret.silent = true;
    if (options.fullResponse)
        ret.fullResponse = true;
    if (options.isCurlFile)
        request = (fs.readFileSync(request)).toString();

    if (request) {
        ret.request = curlToAxios(request);

        let url = new URL(fillUserDefinedVars(ret.request.url))
        let currentParams = new URLSearchParams(url.searchParams);
        let params = new URLSearchParams();
        currentParams.forEach((value, key) => {
            let param = fillUserDefinedVars(value);
            if (param && param !== 'undefined')
                params.set(key, param);
        });
        url.search = params;
        ret.request.url = url.toString();

        fillUserDefinedVars(ret.request);

        if (options.noRedirect)
            ret.request.maxRedirects = 0;

        ret.getJSONPath = function (jsonPath) {
            if (!this.response.data)
                throw new Error('Execute request before filtering it');
            var path = {};
            path.path = jsonPath;
            path.json = this.response.data;
            return JSONPath(path)
        }

        ret.getCookies = function () {
            if (!this.response.data)
                throw new Error('Execute request before filtering it');
            let headers = JSON.stringify(this.response.headers).replace(/set-cookie/g, 'cookies');
            return JSON.parse(headers).cookies.filter((cookie) => cookie.match(/^__.*/g) == null)
        }

        ret.setCookies = function (cookiesArray) {
            var cookies = '';
            cookiesArray.forEach((cookie) => cookies += cookie);
            this.request.headers.Cookie = cookies;
        }

        ret.log = function (request) {
            if (request.response && request.response.config && request.response.data) {
                console.log("\nSENT : " + request.response.config.curlCommand);
                gauge.message("SENT : " + request.response.config.curlCommand);
                console.log("RECV : " + JSON.stringify(request.response.data));
                gauge.message("RECV : " + JSON.stringify(request.response.data));
            }
        }

        ret.execute = async function (doWhile) {

            curlirize(axios, (result, err) => { const { command } = result; });

            var cond = () => { return true };

            if (this.fullResponse)
                this.request.validateStatus = () => { return true };

            if (doWhile)
                cond = this.fullResponse ? () => doWhile.call(this, this.response) : () => doWhile.call(this, this.response.data);


            const axios_retry = async (request) => {
                try {
                    this.response = await axios(request);
                    if (!cond())
                        throw new Error('retry');
                } catch (err) {
                    if (err.message === 'retry') {
                        await new Promise((resolve) => setTimeout(resolve, 1000))
                        this.response = await axios_retry(request)
                    } else {
                        throw err;
                    }
                }
            };

            await axios_retry(this.request);

            if (!this.silent)
                this.log(this);

            return this;
        };
    }
    return ret;

}

function curlToAxios(file) {
    var converted = curlToPostman.convertCurlToRequest(file);
    var ret = { 'method': converted.method, 'url': converted.url, 'headers': {} };

    converted.header.forEach(header => {
        ret.headers[header.key] = header.value;
    });

    if (converted.body.raw) {
        try {
            ret.data = JSON.parse(converted.body.raw);
        } catch (err) {
            ret.data = converted.body.raw
        }
    }
    return ret;
}



function fillUserDefinedVars(obj) {
    /**
     * Will replace all matching {{pattern|defaultValue}} with pattern value found in store 
     * if defaultValue contains 'NotNull' and null value found in store an error will be raised
     * 
     * @param {*} obj : input object
     */


    if (Array.isArray(obj))
        obj.forEach(singleObj => fillUserDefinedVars(singleObj))

    if (typeof (obj) === "string" && obj.match(/{{.*?}}/g)) {

        obj.match(/{{.*?}}/g).forEach(match => {

            //let keyStore, defaultValue;
            //if (match.match(/.*|.*/)) {
            let [keyStore, defaultValue] = match.substring(2).slice(0, -2).split('|');
            //} else {
            //    keyStore = match.substring(2).slice(0, -2);
            //}

            let value = store.get(keyStore) || defaultValue;

            if (value === "NotNull")
                throw new Error('Null value ' + keyStore + ' not allowed');

            try {
                obj = fillUserDefinedVars(JSON.parse(value));
            } catch (err) {
                //obj = obj.replace(match, value ? fillUserDefinedVars(value) : undefined);
                obj = fillUserDefinedVars(obj.replace(match, value));
            }
        });
    }

    if (typeof obj === 'object') {
        Object.keys(obj).forEach((keys) => {
            let value = fillUserDefinedVars(obj[keys]);
            if (value)
                obj[keys] = value;
            else
                delete obj[keys];
        });
    }
    return obj;

}
