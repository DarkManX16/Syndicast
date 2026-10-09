const path = require('path');
const fs = require('fs');

/*
 * Generated-card templates and the moments chosen by hand for movies,
 * `<data>/card-templates.json`:
 *
 *   { "templates": [ { "id": "tpl_...", "name": "Cartoon Theatre Next Time", ... } ],
 *     "moments": { "<server>|<ratingKey>": { "startS": 2661.9, "title": "Scooby-Doo" } } }
 *
 * A template is stored as the Cards page saves it; card-templates.js fills in
 * what is missing when a card is made. A moment belongs to the movie, not to a
 * template, so a stretch picked for Scooby-Doo is the one every card for it
 * uses. See docs/blocks-spec.md, Stage 5, "Generated cards".
 *
 * Reading never creates, rewrites or repairs the file: missing is empty, and one
 * that cannot be read is empty plus a line in the log, left exactly as it was,
 * and refused for writing, so nothing hand-edited is lost to a stray typo.
 * Everything is kept in memory after load, since a break's plan reads templates
 * synchronously.
 */

const FILE_NAME = 'card-templates.json';

class CardTemplateDB {

    constructor(folder) {
        this.file = path.join(folder, FILE_NAME);
        this.data = { templates: [], moments: {} };
        this.unreadable = false;
    }

    async load() {
        let text;
        try {
            text = await fs.promises.readFile(this.file, 'utf8');
        } catch (err) {
            if (err.code !== 'ENOENT') {
                console.error(`Could not read ${this.file}; treating it as having no card templates.`, err.message);
                this.unreadable = true;
            }
            this.data = { templates: [], moments: {} };
            return this.data;
        }
        let parsed;
        try {
            parsed = JSON.parse(text.replace(/^﻿/, ''));
        } catch (err) {
            console.error(`${this.file} is not valid JSON; treating it as having no card templates. It has not been changed.`, err.message);
            this.unreadable = true;
            this.data = { templates: [], moments: {} };
            return this.data;
        }
        this.unreadable = false;
        const templates = (parsed != null) && Array.isArray(parsed.templates)
            ? parsed.templates.filter( (t) => (t != null) && (typeof(t) === 'object') && (typeof(t.id) === 'string') && (t.id !== '') )
            : [];
        const moments = {};
        const stored = (parsed != null) && (parsed.moments != null) && (typeof(parsed.moments) === 'object') ? parsed.moments : {};
        for (const key of Object.keys(stored)) {
            const m = stored[key];
            if ( (m != null) && (typeof(m.startS) === 'number') && isFinite(m.startS) && (m.startS >= 0) ) {
                moments[key] = { startS: m.startS, title: (typeof(m.title) === 'string') ? m.title : '' };
            }
        }
        this.data = { templates: templates, moments: moments };
        return this.data;
    }

    templates() {
        return this.data.templates;
    }

    template(id) {
        return this.data.templates.find( (t) => t.id === id ) || null;
    }

    moment(movieKey) {
        const m = this.data.moments[movieKey];
        return (m == null) ? null : m.startS;
    }

    moments() {
        return this.data.moments;
    }

    async write() {
        if (this.unreadable) {
            throw new Error(`${this.file} could not be read, so it is not being overwritten. Fix or move it, then reload.`);
        }
        const text = JSON.stringify( { templates: this.data.templates, moments: this.data.moments }, null, 2 );
        const tmp = this.file + '.tmp';
        await fs.promises.writeFile(tmp, text, 'utf8');
        await fs.promises.rename(tmp, this.file);
    }

    // Adds or replaces a template (by id; one without an id gets a new one). Returns it.
    async saveTemplate(template) {
        const t = Object.assign({}, template);
        if ( (typeof(t.id) !== 'string') || (t.id === '') ) {
            t.id = 'tpl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        }
        if (this.unreadable) {
            await this.write();
        }
        const others = this.data.templates.filter( (x) => x.id !== t.id );
        const at = this.data.templates.findIndex( (x) => x.id === t.id );
        const next = others.slice();
        next.splice( (at === -1) ? next.length : at, 0, t );
        const before = this.data.templates;
        this.data.templates = next;
        try {
            await this.write();
        } catch (err) {
            this.data.templates = before;
            throw err;
        }
        return t;
    }

    async deleteTemplate(id) {
        const before = this.data.templates;
        this.data.templates = before.filter( (t) => t.id !== id );
        try {
            await this.write();
        } catch (err) {
            this.data.templates = before;
            throw err;
        }
    }

    // A movie's chosen moment (seconds from its start), or null to go back to the picked one.
    async setMoment(movieKey, startS, title) {
        const before = this.data.moments;
        const next = Object.assign({}, before);
        if ( (typeof(startS) === 'number') && isFinite(startS) && (startS >= 0) ) {
            next[movieKey] = { startS: startS, title: (typeof(title) === 'string') ? title : ( (before[movieKey] || {}).title || '' ) };
        } else {
            delete next[movieKey];
        }
        this.data.moments = next;
        try {
            await this.write();
        } catch (err) {
            this.data.moments = before;
            throw err;
        }
    }
}

module.exports = CardTemplateDB;
