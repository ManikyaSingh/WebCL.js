function initGL(canvas){
	let gl = canvas.getContext("webgl2", {
		alpha: false, 
		depth: false,
		stencil: false,
		desynchronized: true,
		antialias: false,
		failIfMajorPerformanceCaveat: false,
		powerPreference: "default", // "high-performance , low-power"
		premultipliedAlpha: true,
		preserveDrawingBuffer: false,
		xrCompatible: false
	});
	if(!gl){
		throw new Error("Unable to initialize WebGL2.");
	}
	if (!gl.getExtension('EXT_color_buffer_float')){
		throw new Error('Error: EXT_color_buffer_float not supported.');
	}
	return gl;
}

function getTexSize(size){
	return Math.ceil(Math.sqrt(size/4));
}

export function GPU(){
	let gl = initGL(document.createElement('canvas'));

	function getFrameBufferStatusMsg(frameBufferStatus){
		if(frameBufferStatus == gl.FRAMEBUFFER_COMPLETE) return 'The framebuffer is ready to display.';
		if(frameBufferStatus == gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT) return 'The attachment types are mismatched or not all framebuffer attachment points are framebuffer attachment complete.';
		if(frameBufferStatus == gl.FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT) return 'There is no attachment.';
		if(frameBufferStatus == gl.FRAMEBUFFER_INCOMPLETE_DIMENSIONS) return 'Height and width of the attachment are not the same.';
		if(frameBufferStatus == gl.FRAMEBUFFER_UNSUPPORTED) return 'The format of the attachment is not supported or if depth and stencil attachments are not the same renderbuffer.';
		// When using a WebGL 2 context, the following values can be returned additionally:
		// gl.FRAMEBUFFER_INCOMPLETE_MULTISAMPLE: The values of gl.RENDERBUFFER_SAMPLES are different among attached renderbuffers, or are non-zero if the attached images are a mix of renderbuffers and textures.
		// When using the OVR_multiview2 extension, the following value can be returned additionally:
		// ext.FRAMEBUFFER_INCOMPLETE_VIEW_TARGETS_OVR: If baseViewIndex is not the same for all framebuffer attachment points where the value of FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE is not NONE, the framebuffer is considered incomplete
		return 'unknown status';
	}
  
	let maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
	let maxTextureUnits = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS);
	let maxColorUnits = gl.getParameter(gl.MAX_COLOR_ATTACHMENTS);
	function newBuffer(data, f, e) {
		let buf = gl.createBuffer();
		gl.bindBuffer((e || gl.ARRAY_BUFFER), buf);
		gl.bufferData((e || gl.ARRAY_BUFFER), new (f || Float32Array)(data), gl.STATIC_DRAW);
		return buf;
	}
	let positionBuffer = newBuffer([ -1, -1, 1, -1, 1, 1, -1, 1 ]);
	let textureBuffer  = newBuffer([  0,  0, 1,  0, 1, 1,  0, 1 ]);
	let indexBuffer    = newBuffer([  1,  2, 0,  3, 0, 2 ], Uint16Array, gl.ELEMENT_ARRAY_BUFFER);
	
	let vertexShaderCode = "#version 300 es"+
	"\n"+
	"precision highp float;\n"+
	"in vec2 _webcl_position;\n" +
	"out vec2 _webcl_pos;\n" +
	"in vec2 _webcl_texture;\n" +
	"\n" +
	"void main(void) {\n" +
	"  _webcl_pos = _webcl_texture;\n" +
	"  gl_Position = vec4(_webcl_position.xy, 0.0, 1.0);\n" +
	"}";
	let vertexShader = gl.createShader(gl.VERTEX_SHADER);
	gl.shaderSource(vertexShader, vertexShaderCode);
	gl.compileShader(vertexShader);
	if (!gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS))
		throw new Error(
			"\nError: Vertex shader build failed\n" + "\n" +
			"--- CODE DUMP ---\n" + vertexShaderCode + "\n\n" +
			"--- ERROR LOG ---\n" + gl.getShaderInfoLog(vertexShader)
		);
	function Buffer(size, arr = null){
		function createTexture(data, size) {
			let texture = gl.createTexture();
			return texture;
		}
		function setTexture(texture, data, size) {
			gl.bindTexture(gl.TEXTURE_2D, texture);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, size, size, 0, gl.RGBA, gl.FLOAT, data);
			gl.bindTexture(gl.TEXTURE_2D, null);
			return texture;
		}
		if(!(size > 0)){
			throw new Error("Buffer size must be > 0");
		}
		this.size = size;
		this.texSize = getTexSize(size);
		this.data = new Float32Array(this.texSize*this.texSize*4);
		this.texture = null;
		// this.mem = Math.pow(4, Math.ceil(Math.log(this.length) / Math.log(4)));
		if (this.texSize > maxTextureSize){
			throw new Error("ERROR: Texture size not supported!");
		}
		this.set = function(arr){
			for(let i=0;i<Math.min(this.data.length, arr.length);i++){
				this.data[i] = arr[i];
			}
		}
		if(arr){
			this.set(arr);
		}
		this.alloc = function(){
			if(this.texture == null){
				this.texture = createTexture(this.data, this.texSize);
			}
			setTexture(this.texture, this.data, this.texSize);
			return this.texture;
		}
		this.free = function(){
			if(this.texture != null){
				gl.deleteTexture(this.texture);
			}
			this.texture = null;
		}
	}
	function Program(inpSize, opSize, code){
		if(!(opSize.length > 0)){
			throw new Error("output length >0 required");
		}
		if(inpSize.length > maxTextureUnits){
			throw new Error("max input buffers supported = ", maxTextureUnits);
		}
		if(opSize.length > maxColorUnits){
			throw new Error("max output buffers supported = ", maxColorUnits);
		}

		let sizeO = getTexSize(opSize[0]);
		let fragmentShaderCode = `#version 300 es
		precision highp float;
		float _webcl_inpSize[${inpSize.length}] = float[](${inpSize.join('.,')}.);
		float _webcl_opSize[${opSize.length}] = float[](${opSize.join('.,')}.);
		${inpSize.length ? `float _webcl_sizeI[${inpSize.length}] = float[](${inpSize.map(x => getTexSize(x)+'.').join(',')});uniform sampler2D _webcl_uTexture[${inpSize.length}];` : ''}
		float _webcl_sizeO = ${sizeO}.;
		in vec2 _webcl_pos;
        #define _webcl_getIndex() (( (_webcl_pos.y*_webcl_sizeO - 0.5)*_webcl_sizeO + (_webcl_pos.x*_webcl_sizeO - 0.5) )*4. + _webcl_i)
		${opSize.map((x,i) => `layout(location = ${i}) out vec4 _webcl_out${i};`).join('\n')}
		
		#define _webcl_readI(n,i) texture(_webcl_uTexture[n], (0.5 + vec2(mod(floor(i/4.), _webcl_sizeI[n]), floor(floor(i/4.)/_webcl_sizeI[n])))/_webcl_sizeI[n])[int(mod(i, 4.))]
		${inpSize.map((x,i) => `#define _webcl_readI${i}(i) _webcl_readI(${i},i)`).join('\n')}
		${opSize.map((x,i) => `#define _webcl_commit${i}(val) _webcl_out${i}[_webcl_I] = val`).join('\n')}
		void main(void){
			#define _webcl_i 0.
			#define _webcl_I 0
			float _webcl_index = floor(_webcl_getIndex());
			{
				${code}
			}
			#undef _webcl_i
			#define _webcl_i 1.
			#undef _webcl_I
			#define _webcl_I 1
			_webcl_index += 1.;
			{
				${code}
			}
			#undef _webcl_i
			#define _webcl_i 2.
			#undef _webcl_I
			#define _webcl_I 2
			_webcl_index += 1.;
			{
				${code}
			}
			#undef _webcl_i
			#define _webcl_i 3.
			#undef _webcl_I
			#define _webcl_I 3
			_webcl_index += 1.;
			{
				${code}
			}
				
		}
		`;
		console.log(vertexShaderCode);
		console.log(fragmentShaderCode);
		var fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);

		gl.shaderSource(
			fragmentShader,
			fragmentShaderCode
		);
		gl.compileShader(fragmentShader);
		if (!gl.getShaderParameter(fragmentShader, gl.COMPILE_STATUS)) {
			var LOC = (fragmentShaderCode).split('\n');
			var dbgMsg = "ERROR: Could not build shader (fatal).\n\n------------------ KERNEL CODE DUMP ------------------\n"
			for (var nl = 0; nl < LOC.length; nl++)
				dbgMsg += (1 + nl) + "> " + LOC[nl] + "\n";
			dbgMsg += "\n--------------------- ERROR  LOG ---------------------\n" + gl.getShaderInfoLog(fragmentShader)
			throw new Error(dbgMsg);
		}
		let program = gl.createProgram();
		gl.attachShader(program, vertexShader);
		gl.attachShader(program, fragmentShader);


		this.new = function(newInpSize, newOpSize){
			return new Program(newInpSize, newOpSize, code);
		}

		this.exec = function(inp, op, transferOutput = false, transferIndex = null){
			gl.linkProgram(program);
			if (!gl.getProgramParameter(program, gl.LINK_STATUS))
				throw new Error('ERROR: Can not link GLSL program!');
			var v_texture = [];
			for(let i=0;i<inp.length;i++){
				v_texture.push(gl.getUniformLocation(program, '_webcl_uTexture['+i+']'));
			}
			var aPosition = gl.getAttribLocation(program, '_webcl_position');
			var aTexture = gl.getAttribLocation(program, '_webcl_texture');
			gl.viewport(0, 0, sizeO, sizeO);
			var fbo = gl.createFramebuffer();
			gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
			var colAt = [];
			for(let i=0;i<op.length;i++){
				op[i].alloc();
				gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0+i, gl.TEXTURE_2D, op[i].texture, 0);
				colAt.push(gl.COLOR_ATTACHMENT0+i);
			}
			var frameBufferStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
			if (frameBufferStatus !== gl.FRAMEBUFFER_COMPLETE){
				throw new Error('ERROR: ' + getFrameBufferStatusMsg(frameBufferStatus));
			}
			gl.bindBuffer(gl.ARRAY_BUFFER, textureBuffer);
			gl.enableVertexAttribArray(aTexture);
			gl.vertexAttribPointer(aTexture, 2, gl.FLOAT, false, 0, 0);
			gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
			gl.enableVertexAttribArray(aPosition);
			gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);
			gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);

			gl.drawBuffers(colAt);


			gl.useProgram(program);
			for(let i=0;i<inp.length;i++){
				gl.activeTexture(gl.TEXTURE0+i);
				gl.bindTexture(gl.TEXTURE_2D, inp[i].texture);
				gl.uniform1i(v_texture[i], i);
			}
			
			gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
			if(transferOutput){
				if(transferIndex === null){
					for(let i=0;i<op.length;i++){
						gl.readBuffer(gl.COLOR_ATTACHMENT0+i);
						// assuming a framebuffer is bound with the texture to read attached
						// const format = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT);
						// const type = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE);
						// console.log(gl, format, type);
						gl.readPixels(0, 0, sizeO, sizeO, gl.RGBA, gl.FLOAT, op[i].data);
					}
				}else{
					gl.readBuffer(gl.COLOR_ATTACHMENT0+transferIndex);
					gl.readPixels(0, 0, sizeO, sizeO, gl.RGBA, gl.FLOAT, op[transferIndex].data);
				}
			}
		}
	}

	this.Buffer = function(size, data){
		return new Buffer(size, data);
	}

	this.Program = function(inp, op, code){
		return new Program(inp, op, code);
	}

}