import AppKit
let out = CommandLine.arguments[1]
let image = NSImage(size: NSSize(width:1024,height:1024))
image.lockFocus()
NSColor(calibratedRed:0.12,green:0.13,blue:0.15,alpha:1).setFill()
NSBezierPath(roundedRect:NSRect(x:48,y:48,width:928,height:928),xRadius:208,yRadius:208).fill()
let attributes: [NSAttributedString.Key:Any] = [.font:NSFont.systemFont(ofSize:680,weight:.semibold),.foregroundColor:NSColor(calibratedRed:0.92,green:0.90,blue:0.83,alpha:1)]
let string = "K" as NSString
let size=string.size(withAttributes:attributes)
string.draw(at:NSPoint(x:(1024-size.width)/2,y:(1024-size.height)/2+12),withAttributes:attributes)
image.unlockFocus()
let bitmap = NSBitmapImageRep(data:image.tiffRepresentation!)!
try bitmap.representation(using:.png,properties:[:])!.write(to:URL(fileURLWithPath:out))
