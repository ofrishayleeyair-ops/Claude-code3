import ctypes as C,json,sys
E=C.CDLL('libEGL.so.1');E.eglGetProcAddress.argtypes=[C.c_char_p];E.eglGetProcAddress.restype=C.c_void_p
def egl(name,restype,args):
 fn=getattr(E,name);fn.restype=restype;fn.argtypes=args;return fn
getDisplay=C.CFUNCTYPE(C.c_void_p,C.c_uint,C.c_void_p,C.POINTER(C.c_int))(E.eglGetProcAddress(b'eglGetPlatformDisplayEXT'))
display=getDisplay(0x31DD,None,None)
major,minor=C.c_int(),C.c_int();assert egl('eglInitialize',C.c_uint,[C.c_void_p,C.POINTER(C.c_int),C.POINTER(C.c_int)])(display,C.byref(major),C.byref(minor))
assert egl('eglBindAPI',C.c_uint,[C.c_uint])(0x30A0)
attrs=(C.c_int*13)(0x3024,8,0x3023,8,0x3022,8,0x3033,1,0x3040,4,0x3025,16,0x3038)
config=C.c_void_p();num=C.c_int();assert egl('eglChooseConfig',C.c_uint,[C.c_void_p,C.POINTER(C.c_int),C.POINTER(C.c_void_p),C.c_int,C.POINTER(C.c_int)])(display,attrs,C.byref(config),1,C.byref(num))
ctx=egl('eglCreateContext',C.c_void_p,[C.c_void_p,C.c_void_p,C.c_void_p,C.POINTER(C.c_int)])(display,config,None,(C.c_int*3)(0x3098,2,0x3038))
surf=egl('eglCreatePbufferSurface',C.c_void_p,[C.c_void_p,C.c_void_p,C.POINTER(C.c_int)])(display,config,(C.c_int*5)(0x3057,64,0x3056,64,0x3038))
assert egl('eglMakeCurrent',C.c_uint,[C.c_void_p,C.c_void_p,C.c_void_p,C.c_void_p])(display,surf,surf,ctx)
def gl(name,restype,args):
 p=E.eglGetProcAddress(name.encode());assert p,name;return C.CFUNCTYPE(restype,*args)(p)
create=gl('glCreateShader',C.c_uint,[C.c_uint]);source=gl('glShaderSource',None,[C.c_uint,C.c_int,C.POINTER(C.c_char_p),C.POINTER(C.c_int)]);compile_=gl('glCompileShader',None,[C.c_uint]);get=gl('glGetShaderiv',None,[C.c_uint,C.c_uint,C.POINTER(C.c_int)]);log=gl('glGetShaderInfoLog',None,[C.c_uint,C.c_int,C.POINTER(C.c_int),C.c_char_p]);createProg=gl('glCreateProgram',C.c_uint,[]);attach=gl('glAttachShader',None,[C.c_uint,C.c_uint]);link=gl('glLinkProgram',None,[C.c_uint]);getP=gl('glGetProgramiv',None,[C.c_uint,C.c_uint,C.POINTER(C.c_int)]);logP=gl('glGetProgramInfoLog',None,[C.c_uint,C.c_int,C.POINTER(C.c_int),C.c_char_p]);getStr=gl('glGetString',C.c_char_p,[C.c_uint]);print('Renderer:',getStr(0x1F01).decode())
failed=False
for program in json.load(open(__import__('pathlib').Path(__file__).with_name('native-shader-programs.json'))):
 shaders=[]
 for name,kind in [('vertex',0x8B31),('fragment',0x8B30)]:
  shader=create(kind);b=program[name].encode();ptr=C.c_char_p(b);source(shader,1,C.byref(ptr),None);compile_(shader);status=C.c_int();get(shader,0x8B81,C.byref(status));buf=C.create_string_buffer(8192);log(shader,len(buf),None,buf)
  if not status.value:print('FAIL',program['name'],name,buf.value.decode());failed=True
  shaders.append(shader)
 pr=createProg()
 for s in shaders:attach(pr,s)
 link(pr);status=C.c_int();getP(pr,0x8B82,C.byref(status));buf=C.create_string_buffer(8192);logP(pr,len(buf),None,buf)
 if not status.value:print('LINK FAIL',program['name'],buf.value.decode());failed=True
 else:print('PASS',program['name'])
sys.exit(1 if failed else 0)
