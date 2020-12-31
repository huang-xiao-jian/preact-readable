// @ts-nocheck
import options from '../options';
import { IS_NON_DIMENSIONAL } from '../constants';
import { isObject, isString } from '../util';

/**
 * Diff the old and new properties of a VNode and apply changes to the DOM node
 * @param {import('../internal').PreactElement} dom The DOM node to apply
 * changes to
 * @param {object} newProps The new props
 * @param {object} oldProps The old props
 * @param {boolean} isSvg Whether or not this node is an SVG node
 */
export function diffProps(dom, newProps, oldProps, isSvg) {
	// 特殊属性 diff 函数内部处理
	const logicals = ['key', 'children', 'dangerouslySetInnerHTML'];
	// value, checked 需要特殊处理，diffChildren 函数内部说明
	const specials = ['value', 'checked'];

	// 删除 property 遗留
	Reflect.ownKeys(oldProps)
		.filter(property => !logicals.includes(property))
		.filter(property => !Reflect.has(newProps, property))
		.forEach(property => {
			setProperty(dom, property, null, oldProps[property], isSvg);
		});

	// 筛选待更新属性
	Reflect.ownKeys(newProps)
		.filter(property => !logicals.includes(property))
		.filter(property => !specials.includes(property))
		.filter(property => oldProps[property] !== newProps[property])
		.forEach(property => {
			setProperty(dom, property, newProps[property], oldProps[property], isSvg);
		});
}

/**
 * Set a property value on a DOM node
 * @param {import('../internal').PreactElement} dom The DOM node to modify
 * @param {string} name The name of the property to set
 * @param {*} value The value to set the property to
 * @param {*} oldValue The old value the property had
 * @param {boolean} isSvg Whether or not this DOM node is an SVG node or not
 */
export function setProperty(dom, name, value, oldValue, isSvg) {
	// svg 元素，DOM 修改 class key 不一致
	if (isSvg) {
		if (name === 'className') {
			name = 'class';
		}
	} else if (name === 'class') {
		name += 'Name';
	}

	if (name === 'style') {
		setStyle(dom, value, oldValue);
	}
	// Benchmark for comparison: https://esbench.com/bench/574c954bdb965b9a00965ac6
	else if (name[0] === 'o' && name[1] === 'n') {
		setEventListerner(dom, name, value, oldValue);
	}
	// dom properties, special keys
	else if (
		!isSvg &&
		name !== 'list' &&
		name !== 'tagName' &&
		// HTMLButtonElement.form and HTMLInputElement.form are read-only but can be set using
		// setAttribute
		name !== 'form' &&
		name !== 'type' &&
		name !== 'size' &&
		name !== 'download' &&
		name !== 'href' &&
		name in dom
	) {
		dom[name] = value == null ? '' : value;
	}
	// dom attibute can't be function type
	else if (typeof value != 'function') {
		setAttribute(dom, name, value);
	}
}

/**
 * =============================================================================
 * style property
 * =============================================================================
 */

/**
 * @param {CSSStyleDeclaration} style
 * @param {string} key
 * @param {*} value
 */
function setStyleLiteral(style, key, value) {
	// resolve empty
	if (value == null) {
		style[key] = '';
	}
	// css variables
	else if (key[0] === '-') {
		style.setProperty(key, value);
	} else if (typeof value != 'number' || IS_NON_DIMENSIONAL.test(key)) {
		style[key] = value;
	}
	// automatical add px unit for possible property
	else {
		style[key] = value + 'px';
	}
}

/**
 * @description - differentiate style
 *
 * @param {HTMLElement} dom
 * @param {Object | string | null} value
 * @param {Object | string | null} oldValue
 */
function setStyle(dom, value, oldValue) {
	// see https://developer.mozilla.org/zh-CN/docs/Web/API/CSSStyleDeclaration
	// value 取值可以为字符串，cssText 最高优先级，直接覆盖即可
	if (typeof value == 'string') {
		dom.style.cssText = value;
	}
	// value 取值可以为字面量对象
	else if (isObject(value)) {
		// 旧值为字符串
		if (isString(oldValue)) {
			dom.style.cssText = '';
			oldValue = '';
		}

		// 旧值为对象，删除所有遗留字段
		if (isObject(oldValue)) {
			for (let name in oldValue) {
				if (!(name in value)) {
					setStyleLiteral(dom.style, name, '');
				}
			}
		}

		// 添加、更新变更字段
		for (let name in value) {
			// 旧值为字符串，添加新字段
			if (!oldValue) {
				setStyleLiteral(dom.style, name, value[name]);
			}

			// 更新属性
			if (value[name] !== oldValue[name]) {
				setStyleLiteral(dom.style, name, value[name]);
			}
		}
	}
	// fallback, value 取值不合法
	else {
		// 粗暴覆盖
		dom.style.cssText = '';
	}
}

/**
 * =============================================================================
 * event listener
 * =============================================================================
 */

/**
 * Proxy an event to hooked event handlers, this --> dom
 * @param {Event} e The event object from the browser
 * @private
 */
function eventProxy(e) {
	this._listeners[e.type + false](options.event ? options.event(e) : e);
}

/**
 * Proxy an event to hooked event handlers
 * @param {Event} e The event object from the browser
 * @private
 */
function eventProxyCapture(e) {
	this._listeners[e.type + true](options.event ? options.event(e) : e);
}

/**
 * @param {HTMLElement} dom
 * @param {string} name
 * @param {Function} value
 * @param {Function} oldValue
 */
function setEventListerner(dom, name, value, oldValue) {
	// 事件监听 capture 标记
	const suffix = /Capture$/;
	const useCapture = suffix.test(name);
	const eventProxyHandler = useCapture ? eventProxyCapture : eventProxy;

	// 删除自定义后缀，标准化
	name = name.replace(suffix, '');

	const lowercaseName = name.toLowerCase();

	// TODO - 那种场景需要保留原始写法
	if (lowercaseName in dom) {
		name = lowercaseName;
	}

	// 删除 on 前缀
	name = name.slice(2);

	// 使用代理模式，避免频繁新增、删除监听
	if (!dom._listeners) {
		dom._listeners = {};
	}

	dom._listeners[name + useCapture] = value;

	// 新值存在，旧值不存在，需要监听事件
	if (value) {
		if (!oldValue) {
			dom.addEventListener(name, eventProxyHandler);
		}
	}
	// 新值不存在，说明监听取消
	else {
		dom.removeEventListener(name, eventProxyHandler);
	}
}

/**
 * Set a property value on a DOM node
 * @param {import('../internal').PreactElement} dom The DOM node to modify
 * @param {string} name The name of the property to set
 * @param {*} value The value to set the property to
 */
function setAttribute(dom, name, value) {
	if (name !== (name = name.replace(/xlink:?/, ''))) {
		if (value == null || value === false) {
			dom.removeAttributeNS('http://www.w3.org/1999/xlink', name.toLowerCase());
		} else {
			dom.setAttributeNS(
				'http://www.w3.org/1999/xlink',
				name.toLowerCase(),
				value
			);
		}
	} else if (
		value == null ||
		(value === false &&
			// ARIA-attributes have a different notion of boolean values.
			// The value `false` is different from the attribute not
			// existing on the DOM, so we can't remove it. For non-boolean
			// ARIA-attributes we could treat false as a removal, but the
			// amount of exceptions would cost us too many bytes. On top of
			// that other VDOM frameworks also always stringify `false`.
			!/^ar/.test(name))
	) {
		dom.removeAttribute(name);
	} else {
		dom.setAttribute(name, value);
	}
}
